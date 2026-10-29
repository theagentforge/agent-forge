// A small streaming tar reader for the bulk skill scan (ADR 0107, moved into the Worker by ADR 0112). It reads GitHub's
// repository tarballs and keeps only regular files it is asked for, as bytes in memory. It never writes a file
// anywhere, never follows links, and never runs anything: the files are untrusted text.
//
// Format: POSIX ustar, with pax extended headers (path=) and GNU long names (typeflag L), which is what GitHub's
// `git archive` tarballs use. Each header is 512 bytes; file data is padded to 512. GitHub's first entry is a global pax
// header whose `comment` record is the commit the archive was made from.

const BLOCK = 512;
const dec = new TextDecoder();

/** Octal (or GNU base-256) number field. */
export function tarNumber(buf: Uint8Array): number {
  if (buf[0]! & 0x80) {
    let n = 0;
    for (let i = 1; i < buf.length; i++) n = n * 256 + buf[i]!;
    return n;
  }
  const s = dec.decode(buf).replace(/\0.*$/s, "").trim();
  return s ? parseInt(s, 8) : 0;
}

const str = (buf: Uint8Array) => dec.decode(buf).replace(/\0.*$/s, "");

/** pax "len key=value\n" records → { path, comment, … }. */
export function parsePax(buf: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  const text = dec.decode(buf);
  let i = 0;
  while (i < text.length) {
    const sp = text.indexOf(" ", i);
    if (sp < 0) break;
    const len = parseInt(text.slice(i, sp), 10);
    if (!Number.isFinite(len) || len <= 0) break;
    const rec = text.slice(sp + 1, i + len - 1);
    const eq = rec.indexOf("=");
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    i += len;
  }
  return out;
}

type Kind = "pax" | "global" | "long" | "file" | "skip";

export interface TarReaderOptions {
  /** Which regular files to keep (anything else is skipped without being buffered). */
  want: (path: string, size: number) => boolean;
  onFile: (path: string, bytes: Uint8Array) => void;
  /** The archive's global pax records (GitHub: `comment` is the commit id). */
  onGlobal?: (records: Record<string, string>) => void;
  /** Bounds the bytes read: a decompression bomb stops the reader instead of filling memory. */
  maxTotal?: number;
}

/** Push-based reader: call write(chunk) with decompressed bytes, then end(). */
export class TarReader {
  private readonly want: TarReaderOptions["want"];
  private readonly onFile: TarReaderOptions["onFile"];
  private readonly onGlobal: NonNullable<TarReaderOptions["onGlobal"]>;
  private readonly maxTotal: number;
  private total = 0;
  private pending: Uint8Array[] = [];
  private pendingLen = 0;
  private state: "header" | "data" | "skip" | "skipping" = "header";
  private need = BLOCK;
  private entry: { kind: Kind; size: number; path: string } | null = null;
  private paxPath: string | null = null;
  private longName: string | null = null;
  private skipLeft = 0;
  done = false;
  files = 0;
  skipped = 0;

  constructor(o: TarReaderOptions) {
    this.want = o.want;
    this.onFile = o.onFile;
    this.onGlobal = o.onGlobal ?? (() => {});
    this.maxTotal = o.maxTotal ?? 4 * 1024 ** 3;
  }

  write(chunk: Uint8Array) {
    if (this.done) return;
    this.total += chunk.length;
    if (this.total > this.maxTotal) throw new Error("tarball larger than the limit");
    if (this.state === "skipping") {
      // The rest of an unwanted file: dropped as it arrives, never kept.
      if (chunk.length <= this.skipLeft) {
        this.skipLeft -= chunk.length;
        if (this.skipLeft === 0) this.toHeader();
        return;
      }
      chunk = chunk.subarray(this.skipLeft);
      this.skipLeft = 0;
      this.toHeader();
    }
    this.pending.push(chunk);
    this.pendingLen += chunk.length;
    while (!this.done && this.state !== "skipping" && this.pendingLen >= this.need) this.step(this.take(this.need));
  }

  end() {
    if (!this.done && this.state !== "header") throw new Error("tarball ended inside an entry");
  }

  private toHeader() {
    this.state = "header";
    this.need = BLOCK;
    this.entry = null;
  }

  private take(n: number): Uint8Array {
    const out = new Uint8Array(n);
    let off = 0;
    while (off < n) {
      const head = this.pending[0]!;
      const k = Math.min(head.length, n - off);
      out.set(head.subarray(0, k), off);
      off += k;
      if (k === head.length) this.pending.shift();
      else this.pending[0] = head.subarray(k);
    }
    this.pendingLen -= n;
    return out;
  }

  private step(block: Uint8Array) {
    if (this.state === "header") return this.header(block);
    const e = this.entry!;
    if (this.state === "data") {
      const data = block.subarray(0, e.size);
      if (e.kind === "pax") {
        const pax = parsePax(data);
        if (pax.path) this.paxPath = pax.path;
      } else if (e.kind === "global") this.onGlobal(parsePax(data));
      else if (e.kind === "long") this.longName = str(data);
      else if (e.kind === "file") {
        this.files++;
        this.onFile(e.path, data);
      }
    }
    this.toHeader();
  }

  private header(h: Uint8Array) {
    if (h.every((b) => b === 0)) {
      // Two zero blocks end the archive; one is enough for us.
      this.done = true;
      return;
    }
    const type = String.fromCharCode(h[156] || 48);
    const size = tarNumber(h.subarray(124, 136));
    const name = str(h.subarray(0, 100));
    const prefix = str(h.subarray(345, 345 + 155));
    const magic = str(h.subarray(257, 263));
    const path = this.paxPath ?? this.longName ?? (magic.startsWith("ustar") && prefix ? `${prefix}/${name}` : name);
    const padded = Math.ceil(size / BLOCK) * BLOCK;
    let kind: Kind = "skip";
    if (type === "x") kind = size <= 1024 * 1024 ? "pax" : "skip";
    else if (type === "L") kind = size <= 64 * 1024 ? "long" : "skip";
    else if (type === "g") kind = size <= 64 * 1024 ? "global" : "skip";
    else {
      // Every other type (links, devices, folders) is skipped; only a regular file can be kept.
      this.paxPath = null;
      this.longName = null;
      if ((type === "0" || type === "\0" || type === "7") && this.want(path, size)) kind = "file";
      else this.skipped++;
    }
    if (padded === 0) {
      if (kind === "file") {
        this.files++;
        this.onFile(path, new Uint8Array(0));
      }
      return;
    }
    this.entry = { kind, size, path };
    this.state = kind === "skip" ? "skip" : "data";
    this.need = padded;
    if (kind === "skip") this.skipBytes(padded);
  }

  /** Drops `n` bytes without copying them into one buffer (large files we don't want). */
  private skipBytes(n: number) {
    let left = n;
    while (left > 0 && this.pending.length) {
      const head = this.pending[0]!;
      if (head.length <= left) {
        left -= head.length;
        this.pendingLen -= head.length;
        this.pending.shift();
      } else {
        this.pending[0] = head.subarray(left);
        this.pendingLen -= left;
        left = 0;
      }
    }
    if (left === 0) this.toHeader();
    else {
      this.state = "skipping";
      this.need = 0;
      this.skipLeft = left;
    }
  }
}

/** Builds a tar archive in memory (tests only): entries [{ path, data, type }]. Uses pax headers for long paths. */
export function makeTar(entries: { path: string; data?: string | Uint8Array; type?: string; pax?: boolean }[]): Uint8Array {
  const blocks: Uint8Array[] = [];
  const enc = new TextEncoder();
  const header = (name: string, size: number, type: string) => {
    const h = new Uint8Array(BLOCK);
    h.set(enc.encode(name.slice(0, 100)), 0);
    h.set(enc.encode("0000644\0"), 100);
    h.set(enc.encode("0000000\0"), 108);
    h.set(enc.encode("0000000\0"), 116);
    h.set(enc.encode(`${size.toString(8).padStart(11, "0")}\0`), 124);
    h.set(enc.encode("00000000000\0"), 136);
    h[156] = type.charCodeAt(0);
    h.set(enc.encode("ustar\0"), 257);
    h.set(enc.encode("00"), 263);
    h.set(enc.encode("        "), 148);
    let sum = 0;
    for (const b of h) sum += b;
    h.set(enc.encode(`${sum.toString(8).padStart(6, "0")}\0 `), 148);
    return h;
  };
  const pad = (data: Uint8Array) => {
    const out = new Uint8Array(Math.ceil(data.length / BLOCK) * BLOCK);
    out.set(data);
    return out;
  };
  for (const e of entries) {
    const data = typeof e.data === "string" ? enc.encode(e.data) : (e.data ?? new Uint8Array(0));
    const type = e.type ?? "0";
    const carriesData = type === "0" || type === "g";
    if (e.path.length > 100 || e.pax) {
      const rec = (k: string, v: string) => {
        const body = ` ${k}=${v}\n`;
        let len = body.length + 1;
        while (String(len).length + body.length !== len) len = String(len).length + body.length;
        return `${len}${body}`;
      };
      const pax = enc.encode(rec("path", e.path));
      blocks.push(header("PaxHeader", pax.length, "x"), pad(pax));
    }
    blocks.push(header(e.path, carriesData ? data.length : 0, type));
    if (carriesData) blocks.push(pad(data));
  }
  blocks.push(new Uint8Array(BLOCK * 2));
  const out = new Uint8Array(blocks.reduce((a, b) => a + b.length, 0));
  let off = 0;
  for (const b of blocks) {
    out.set(b, off);
    off += b.length;
  }
  return out;
}

/** A pax record line (tests only): "len key=value\n". */
export function paxRecord(k: string, v: string): string {
  const body = ` ${k}=${v}\n`;
  let len = body.length + 1;
  while (String(len).length + body.length !== len) len = String(len).length + body.length;
  return `${len}${body}`;
}
