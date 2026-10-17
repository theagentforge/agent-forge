import { describe, expect, it } from "vitest";
import { Attempt, type TaskType } from "../src";
import { DETAILS_MAX, hotelUsd, MONDAY, SATURDAY, SUNDAY, THURSDAY, weekendHard3 } from "../src/tasks/weekend-hard3";

// Weekend Planner (Hard v3). The careful play is driven only by what the tools return (never the hidden state). Trap
// plays make one tempting wrong move a frontier model plausibly makes; the "once" versions make it on a single leg or
// stay only. Over-cautious plays must fail a critical checkpoint or bust the budget.

const SEEDS = Array.from({ length: 30 }, (_, i) => (i < 24 ? i + 1 : [1_000_000, 1_234_567_891, 2 ** 31 - 2, 77_777, 424_242, 9_999_999][i - 24]!));
const task = weekendHard3 as TaskType<any>;
const caps = weekendHard3.caps!;
const clock = () => {
  let t = 0;
  return () => (t += 10);
};
const start = (seed: number) => new Attempt(task, seed, { now: clock() });
const json = (a: Attempt<any>, name: string, args: Record<string, unknown> = {}) => {
  const r = a.call(name, args);
  expect(r.ok, `${name} failed: ${r.content}`).toBe(true);
  return JSON.parse(r.content);
};
const usd = (x: string | number) => Math.round(Number(String(x).replace(/[^0-9.]/g, "")) * 100);
const trapOf = (a: Attempt<any>, id: string) => a.result!.traps.find((t) => t.id === id)!.triggered;
const cpOf = (a: Attempt<any>, id: string) => a.result!.checkpoints.find((c) => c.id === id)!.passed;
const anyTrap = (a: Attempt<any>) => a.result!.traps.filter((t) => t.triggered).map((t) => t.id).sort();
const chunks = <T>(xs: T[], n: number) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

/** Tokens a model would use replaying this attempt, `perTurn` calls a turn (same estimate as the v2 tests). */
function tokenEstimate(a: Attempt<any>, perTurn: number) {
  const fixed = (a.variant.brief.length + JSON.stringify(a.toolSpecs()).length) / 3 + 1500;
  const sizes = new Map<number, number>();
  for (const e of a.log) {
    if (e.type === "call" && e.name !== "finish") sizes.set(e.n, JSON.stringify(e.args).length / 3 + 30);
    if (e.type === "result") sizes.set(e.n, (sizes.get(e.n) ?? 0) + JSON.stringify(e.result).length / 3);
    if (e.type === "hit") sizes.set(e.n, (sizes.get(e.n) ?? 0) + e.error.length / 3);
  }
  const steps = [...sizes.values()];
  let ctx = fixed;
  let total = 0;
  let turns = 0;
  for (let i = 0; i < steps.length; i += perTurn) {
    total += ctx + 300;
    turns++;
    for (let j = i; j < Math.min(i + perTurn, steps.length); j++) ctx += steps[j]! + 300 / perTurn;
  }
  return { tokens: Math.round(total + ctx + 300), turns: turns + 1 };
}

interface TripPlay {
  /** Convert displayed times ("convert"), compare them as shown ("naive"), or demand both ("strict"). */
  times?: "convert" | "naive" | "strict";
  /** Use the current UTC offsets and ignore the clock change on the Sunday. */
  staleDst?: boolean;
  /** Only book flights that fit with both the old and the new offsets. */
  staleCautious?: boolean;
  feeBlind?: boolean;
  ignoreCancel?: boolean;
  currencyBlind?: boolean;
  /** Price and book one room whatever it sleeps. */
  ignorePartySize?: boolean;
  /** Make the slip on the first leg or stay where it changes the choice only. */
  once?: boolean;
}

/** Hours before a 15:00 check-in at which free cancellation ends (0 = none). */
const hours = (policy: string) => {
  if (/non-refundable/i.test(policy)) return 0;
  const at = policy.match(/until (\d\d):00 (the day|two days) before/i);
  if (at) return (at[2] === "the day" ? 24 : 48) + 15 - Number(at[1]);
  const h = policy.match(/(\d+) hours?/);
  if (h) return Number(h[1]);
  const d = policy.match(/(\d+) days?/);
  return d ? Number(d[1]) * 24 : 0;
};
const mins = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const offset = (u: string) => {
  const m = u.match(/UTC([+-])(\d\d):(\d\d)/)!;
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
};

function tripPlan(a: Attempt<any>, p: TripPlay) {
  const brief = a.variant.brief;
  const [, home, ca, cb, cc] = brief.match(/from (.+?) to (.+?), on to (.+?), then (.+?), and back home/)!;
  const party = Number(brief.match(/\((\d) travellers\)/)![1]);
  const bags = Number(brief.match(/\((\d) bags\)/)![1]);
  const budget = usd(brief.match(/budget is (\$[\d,.]+)/)![1]!);
  const used = new Set<string>();
  /** Whether the lapse applies at this point (always, or the first time it would change something). */
  const slip = (k: string, changes: boolean) => {
    if (!changes) return false;
    if (p.once && used.size) return false;
    used.add(k);
    return true;
  };
  const zone = new Map<string, { off: number; sunday: number }>();
  for (const c of [home!, ca!, cb!, cc!]) {
    const info = json(a, "get_city_info", { city: c });
    const change = String(info.clock_changes).match(/1 Nov 2026: from then on (UTC[+-]\d\d:\d\d)/);
    zone.set(c, { off: offset(info.utc_offset), sunday: change ? offset(change[1]!) : offset(info.utc_offset) });
  }
  const offOn = (c: string, date: string, stale: boolean) => (date >= SUNDAY && !stale ? zone.get(c)!.sunday : zone.get(c)!.off);
  const legs = [
    { from: home!, to: ca!, date: THURSDAY, earliest: 12 * 60, deadline: 20 * 60 },
    { from: ca!, to: cb!, date: SATURDAY, earliest: 9 * 60, deadline: 17 * 60 },
    { from: cb!, to: cc!, date: SUNDAY, earliest: 10 * 60, deadline: 19 * 60 },
    { from: cc!, to: home!, date: MONDAY, earliest: 0, deadline: 14 * 60 },
  ];
  type Reading = "convert" | "naive" | "stale";
  const fits = (f: any, l: (typeof legs)[number], how: Reading) => {
    const shift = how === "naive" ? 0 : offOn(l.to, l.date, how === "stale") - offOn(l.from, l.date, how === "stale");
    return mins(f.depart) >= l.earliest && mins(f.arrive) + shift <= l.deadline;
  };
  const fareCost = (rule: any) => {
    const bag = /included/i.test(rule.checked_bag) ? 0 : usd(rule.checked_bag);
    const seat = /included/i.test(rule.assigned_seats) ? 0 : usd(rule.assigned_seats);
    return p.feeBlind ? usd(rule.base_fare_per_person) : party * (usd(rule.base_fare_per_person) + usd(rule.taxes_per_person)) + bags * bag + party * seat;
  };
  const picks = legs.map((l) => {
    const flights = json(a, "search_flights", { from: l.from, to: l.to, date: l.date }).flights as any[];
    const ok = (how: (f: any) => boolean) => flights.filter(how);
    const careful = ok((f) => fits(f, l, "convert"));
    // Fetch rules for every flight that fits any reading, so a lapse can pick among them.
    const any = p.times || p.staleDst || p.staleCautious ? ok((f) => fits(f, l, "convert") || fits(f, l, "naive") || fits(f, l, "stale")) : careful;
    const ids = any.flatMap((f: any) => f.fares.filter((x: any) => x.seats_left >= party).map((x: any) => x.fare_id));
    const rules = chunks(ids, DETAILS_MAX).flatMap((c) => json(a, "get_fare_rules", { fare_ids: c }) as any[]);
    const best = (fs: any[]) => rules.filter((x) => fs.some((f) => f.flight_id === x.flight_id) && !/not allowed/i.test(x.checked_bag)).sort((x, y) => fareCost(x) - fareCost(y))[0];
    const chosen = best(careful);
    const alt =
      p.times === "naive"
        ? best(ok((f) => fits(f, l, "naive")))
        : p.times === "strict"
          ? best(ok((f) => fits(f, l, "convert") && fits(f, l, "naive")))
          : p.staleDst
            ? best(ok((f) => fits(f, l, "stale")))
            : p.staleCautious
              ? best(ok((f) => fits(f, l, "convert") && fits(f, l, "stale")))
              : chosen;
    // Once: the naive slip is the first leg where it books a late flight; the cautious slips, the first where they pay more.
    const late = (x: any) => !!x && !fits(flights.find((f) => f.flight_id === x.flight_id), l, "convert");
    return slip("flight", alt?.fare_id !== chosen?.fare_id && (p.times !== "naive" || late(alt))) ? alt : chosen;
  });
  let rate: number | null = null;
  const stays = [
    { city: ca!, checkin: THURSDAY, nights: 2 },
    { city: cb!, checkin: SATURDAY, nights: 1 },
    { city: cc!, checkin: SUNDAY, nights: 1 },
  ];
  const hotels = stays.map((st) => {
    const list = json(a, "search_hotels", { city: st.city }).hotels;
    const details = chunks(list.map((h: any) => h.hotel_id), DETAILS_MAX).flatMap((ids) => json(a, "get_hotel_details", { hotel_ids: ids }) as any[]);
    const plan = (d: any, opts: { currencyBlind?: boolean; onePerRoom?: boolean } = {}) => {
      const rooms = opts.onePerRoom ? 1 : Math.ceil(party / d.max_guests_per_room);
      const room = usd(d.room_rate_per_night) * st.nights * rooms;
      const pct = String(d.city_tax).match(/(\d+)% of the room total/);
      const tax = pct ? Math.round((room * Number(pct[1])) / 100) : party * st.nights * usd(String(d.city_tax).replace(/^[A-Z]{3} /, ""));
      const resort = d.resort_fee_per_room_per_night === "None" ? 0 : usd(d.resort_fee_per_room_per_night) * st.nights * rooms;
      const local = p.feeBlind ? room : room + tax + resort;
      if (d.currency === "USD" || opts.currencyBlind) return { rooms, cost: local };
      rate ??= json(a, "get_exchange_rate", { from: d.currency.slice(0, 3), to: "USD" }).rate as number;
      return { rooms, cost: Math.round(local * rate) };
    };
    const cancelOk = (d: any) => hours(d.cancellation) > 0 && hours(d.cancellation) <= 48;
    const best = (ds: any[], opts: { currencyBlind?: boolean; onePerRoom?: boolean } = {}) => ds.map((d) => ({ d, ...plan(d, opts) })).sort((x, y) => x.cost - y.cost)[0]!;
    const chosen = best(details.filter(cancelOk));
    const alt = p.ignoreCancel ? best(details) : p.currencyBlind ? best(details.filter(cancelOk), { currencyBlind: true }) : p.ignorePartySize ? best(details.filter(cancelOk), { onePerRoom: true }) : chosen;
    const pick = slip("hotel", alt.d.hotel_id !== chosen.d.hotel_id || alt.rooms !== chosen.rooms) ? alt : chosen;
    return { id: pick.d.hotel_id, rooms: pick.rooms };
  });
  return { picks, hotels, stays, budget, party, bags };
}

function playTrip(a: Attempt<any>, p: TripPlay = {}) {
  const plan = tripPlan(a, p);
  for (const fare of plan.picks) json(a, "book_flight", { fare_id: fare.fare_id, passengers: plan.party, checked_bags: plan.bags, assigned_seats: true });
  plan.hotels.forEach((h, i) => json(a, "book_hotel", { hotel_id: h.id, checkin: plan.stays[i]!.checkin, nights: plan.stays[i]!.nights, rooms: h.rooms, guests: plan.party }));
  const total = json(a, "view_bookings").total_charged_usd;
  json(a, "add_calendar_event", { title: "Long weekend", start: `${THURSDAY} 12:00`, end: `${MONDAY} 14:00` });
  a.call("finish", { status: "done", summary: "Booked flights and hotels." });
  return { plan, total: usd(total) };
}

/** Books a plan by option ids, straight from the hidden state (for the solution checks). */
function bookIds(a: Attempt<any>, ids: string[]) {
  const v = a.variant.state;
  const party = v.travellers.length;
  for (const id of ids.slice(0, 4)) {
    const fare = v.flights.flatMap((f: any) => f.fares).find((f: any) => f.id === id);
    a.call("book_flight", { fare_id: id, passengers: party, checked_bags: fare.kind === "basic" ? 0 : v.bags, assigned_seats: true });
  }
  ids.slice(4).forEach((id, i) => {
    const h = v.hotels.find((x: any) => x.id === id);
    a.call("book_hotel", { hotel_id: id, checkin: v.stays[i].checkin, nights: v.stays[i].nights, rooms: Math.ceil(party / h.maxGuests), guests: party });
  });
  a.call("add_calendar_event", { title: "Trip", start: `${THURSDAY} 12:00`, end: `${MONDAY} 14:00` });
  a.call("finish", { status: "done", summary: "Booked." });
  return a.result!;
}

describe("Weekend Planner (Hard v3): the variant", () => {
  it("id, title, trap list and caps", () => {
    expect([weekendHard3.id, weekendHard3.title, weekendHard3.world]).toEqual(["weekend-hard3", "The Weekend Planner (Hard v3)", "travel"]);
    expect(weekendHard3.traps.map((t) => t.id)).toEqual(["over_budget", "missed_window", "dst_miss", "basic_fare_bag", "nonrefundable_hotel", "currency_miss", "room_too_small"]);
    expect(caps.ms).toBeLessThanOrEqual(30 * 60_000);
  });

  it("is deterministic and varied", () => {
    expect(JSON.stringify(weekendHard3.make(3))).toBe(JSON.stringify(weekendHard3.make(3)));
    expect(new Set(SEEDS.map((s) => JSON.stringify(weekendHard3.make(s)))).size).toBe(SEEDS.length);
    const v = SEEDS.map((s) => weekendHard3.make(s).state);
    expect(new Set(v.map((x) => x.travellers.length))).toEqual(new Set([3, 4]));
    expect(new Set(v.map((x) => x.key.dstTrapLeg))).toEqual(new Set([2, 3]));
    expect(new Set(v.map((x) => x.bags)).size).toBeGreaterThanOrEqual(2);
  });

  it.each(SEEDS)("seed %i: four zones, two clock changes, and several instances of every trap family", (seed) => {
    const v = weekendHard3.make(seed).state;
    const party = v.travellers.length;
    for (const f of v.flights) for (const t of [f.depart, f.arrive]) expect(t, `${seed} ${f.id}`).toMatch(/^([01]\d|2[0-3]):[0-5]\d$/);
    for (const f of v.flights) expect(f.depart < f.arrive, `${seed} ${f.id}`).toBe(true);
    expect(new Set(v.flights.map((f) => f.id)).size).toBe(v.flights.length);
    expect(new Set(Object.values(v.zones).map((z) => z.off)).size).toBe(4);
    expect(Object.values(v.zones).filter((z) => z.dst).length).toBeGreaterThanOrEqual(1);
    // About double v2's volume: 4 legs, 30+ flights, 50+ fares, 20 hotels.
    expect(v.flights.length).toBeGreaterThanOrEqual(30);
    expect(v.flights.flatMap((f) => f.fares).length).toBeGreaterThanOrEqual(50);
    expect(v.hotels).toHaveLength(20);
    // Per family: basic fares on every leg; per city a too-strict cancellation and a room that sleeps two; two cities with a krona hotel.
    expect(new Set(v.flights.filter((f) => f.fares.some((x) => x.kind === "basic")).map((f) => f.leg)).size).toBe(4);
    for (const city of v.cities) {
      const hs = v.hotels.filter((h) => h.city === city);
      expect(hs.some((h) => h.cancelHours === 0 || h.cancelHours > 48)).toBe(true);
      expect(hs.some((h) => h.maxGuests < party && h.currency === "USD")).toBe(true);
    }
    expect(v.hotels.filter((h) => h.currency !== "USD")).toHaveLength(2);
    // Time-zone traps: at least two legs where a flight only looks on time unconverted, one where one only looks late.
    const shifts = v.legs.map((l) => (v.zones[l.to]!.dst && l.date >= SUNDAY ? v.zones[l.to]!.dst!.to : v.zones[l.to]!.off) - (v.zones[l.from]!.dst && l.date >= SUNDAY ? v.zones[l.from]!.dst!.to : v.zones[l.from]!.off));
    expect(shifts.filter((s, li) => s > 0 && li !== v.key.dstCautionLeg).length).toBeGreaterThanOrEqual(2);
    expect(shifts.filter((s) => s < 0).length).toBeGreaterThanOrEqual(1);
    expect([v.key.dstTrapLeg, v.key.dstCautionLeg].sort()).toEqual([2, 3]);
    expect(v.budget - v.key.cheapest).toBeLessThanOrEqual(600);
  });

  it("the brief states every rule the referee enforces", () => {
    for (const seed of [1, 2, 3]) {
      const b = weekendHard3.make(seed).brief;
      for (const rule of [
        /leaving at or after 12:00 .+ time and landing in .+ by 20:00 .+ time/,
        /leaving no earlier than 09:00 .+ time and landing in .+ by 17:00/,
        /leaving no earlier than 10:00 .+ time and landing in .+ by 19:00/,
        /landing in .+ by 14:00 .+ time/,
        /all \d travellers together on one fare per flight/,
        /each check one bag on every flight \(\d bags\)/,
        /assigned seats on all four/,
        /2 nights from 2026-10-29/,
        /enough rooms to sleep all \d \(book it for \d guests\)/,
        /free to cancel up to 48 hours before check-in/,
        /fares, taxes, bag and seat fees, rooms, resort fees and city taxes/,
      ])
        expect(b).toMatch(rule);
    }
  });

  it("a valid plan always exists, and every plan the referee passes uses only valid options within budget", () => {
    for (const seed of SEEDS) {
      const v = weekendHard3.make(seed).state;
      const cheapestIds = v.key.options.map((o) => o[0]!.id);
      expect(bookIds(start(seed), cheapestIds).passed, `seed ${seed}`).toBe(true);
      const fxHotels = v.hotels.filter((h) => h.currency !== "USD").map((h) => h.id);
      // A krona hotel never fits the budget in place of the cheapest hotel in its city.
      for (const o of v.key.options.slice(4)) for (const x of o.filter((y) => fxHotels.includes(y.id))) expect(x.cost - o[0]!.cost).toBeGreaterThan(v.budget - v.key.cheapest);
      const legFares = [0, 1, 2, 3].map((i) => v.flights.filter((f) => f.leg === i).flatMap((f) => f.fares.map((x) => x.id)));
      const cityHotels = v.cities.map((c) => v.hotels.filter((h) => h.city === c).map((h) => h.id));
      for (let i = 0; i < 60; i++) {
        const pickAt = (xs: string[], j: number) => xs[(i * 7 + j * 13 + seed) % xs.length]!;
        const ids = [...legFares.map((xs, j) => pickAt(xs, j + i)), ...cityHotels.map((xs, j) => pickAt(xs, j + 2 * i))];
        const a = start(seed);
        if (bookIds(a, ids).passed) {
          ids.forEach((id, j) => expect(v.key.options[j]!.map((o) => o.id)).toContain(id));
          expect(a.state.bookings.reduce((t: number, b: any) => t + b.cost, 0)).toBeLessThanOrEqual(v.budget);
        }
      }
    }
  });

  it("the hidden answer key never reaches the model", () => {
    const LEAK = /"key"|"options"|"cheapest"|dstTrapLeg|dstCautionLeg|cancelHours|"kind"|maxGuests/;
    for (const seed of [1, 2, 2 ** 31 - 2]) {
      const a = start(seed);
      expect(a.variant.brief).not.toMatch(/key|answer/i);
      playTrip(a);
      for (const e of a.log) if (e.type === "result") expect(JSON.stringify(e.result)).not.toMatch(LEAK);
    }
  });
});

describe("Weekend Planner (Hard v3): the careful play", () => {
  it("passes with no trap on every seed, within every cap with at least 25% to spare", () => {
    const used = { calls: 0, turns: 0, tokens: 0 };
    for (const seed of SEEDS) {
      const a = start(seed);
      const { plan, total } = playTrip(a);
      const r = a.result!;
      expect({ seed, passed: r.passed, quality: r.quality, traps: anyTrap(a), reason: r.reason, hits: r.hits }).toEqual({ seed, passed: true, quality: 1, traps: [], reason: "finished", hits: 0 });
      expect(total).toBeLessThanOrEqual(plan.budget);
      const est = tokenEstimate(a, 2);
      used.calls = Math.max(used.calls, r.toolCalls);
      used.turns = Math.max(used.turns, est.turns);
      used.tokens = Math.max(used.tokens, est.tokens);
    }
    expect(used.calls).toBeGreaterThanOrEqual(34);
    expect(used.calls * 1.25).toBeLessThanOrEqual(caps.toolCalls);
    expect(used.turns * 1.25).toBeLessThanOrEqual(caps.turns);
    expect(used.tokens * 1.25).toBeLessThanOrEqual(caps.tokens);
  });
});

describe("Weekend Planner (Hard v3): one slip fails the run", () => {
  it.each([false, true])("reading flight times without converting time zones misses a window (once: %s)", (once) => {
    for (const seed of SEEDS) {
      const a = start(seed);
      playTrip(a, { times: "naive", once });
      expect(trapOf(a, "missed_window") || trapOf(a, "dst_miss"), `seed ${seed}`).toBe(true);
      if (!once) expect(trapOf(a, "missed_window"), `seed ${seed}`).toBe(true);
      expect(a.result!.passed).toBe(false);
    }
  });

  it("ignoring the Sunday clock change books a flight that lands late (dst_miss)", () => {
    for (const seed of SEEDS) {
      const a = start(seed);
      playTrip(a, { staleDst: true });
      expect(trapOf(a, "dst_miss"), `seed ${seed}`).toBe(true);
      expect(trapOf(a, "missed_window")).toBe(false);
      expect(cpOf(a, `leg_${a.variant.state.key.dstTrapLeg + 1}`)).toBe(false);
      expect(a.result!.passed).toBe(false);
    }
  });

  it("refusing the flight that only looks late with the old offsets (DST over-caution) busts the budget", () => {
    for (const seed of SEEDS) {
      const a = start(seed);
      playTrip(a, { staleCautious: true });
      expect(anyTrap(a), `seed ${seed}`).toEqual(["over_budget"]);
      expect(a.result!.passed).toBe(false);
    }
  });

  it("rejecting a flight that only looks late unconverted (over-caution) busts the budget", () => {
    for (const seed of SEEDS) {
      const a = start(seed);
      playTrip(a, { times: "strict", once: true });
      expect(anyTrap(a), `seed ${seed}`).toEqual(["over_budget"]);
      expect(a.result!.passed).toBe(false);
    }
  });

  it("ranking by base fare and room rate alone goes over the all-in budget", () => {
    for (const seed of SEEDS) {
      const a = start(seed);
      const { plan, total } = playTrip(a, { feeBlind: true });
      expect(total).toBeGreaterThan(plan.budget);
      expect(trapOf(a, "over_budget")).toBe(true);
      expect(a.result!.passed).toBe(false);
    }
  });

  it.each([false, true])("the cheapest all-in hotel in each city can't be cancelled for free 48 hours ahead (once: %s)", (once) => {
    for (const seed of SEEDS) {
      const a = start(seed);
      playTrip(a, { ignoreCancel: true, once });
      expect(anyTrap(a), `seed ${seed}`).toEqual(["nonrefundable_hotel"]);
      expect(a.result!.passed).toBe(false);
    }
  });

  it.each([false, true])("reading the krona price as dollars books a dearer hotel (once: %s)", (once) => {
    for (const seed of SEEDS) {
      const a = start(seed);
      playTrip(a, { currencyBlind: true, once });
      expect(anyTrap(a), `seed ${seed}`).toEqual(["currency_miss", "over_budget"]);
      expect(a.result!.passed).toBe(false);
    }
  });

  it.each([false, true])("pricing one room for the whole party books a room too small (once: %s)", (once) => {
    for (const seed of SEEDS) {
      const a = start(seed);
      playTrip(a, { ignorePartySize: true, once });
      expect(anyTrap(a), `seed ${seed}`).toEqual(["room_too_small"]);
      expect(cpOf(a, "hotel_a") && cpOf(a, "hotel_b") && cpOf(a, "hotel_c")).toBe(false);
      expect(a.result!.passed).toBe(false);
    }
  });

  it("booking for fewer guests than are travelling is the same trap; a fare without bags is a trap even with none booked", () => {
    for (const seed of SEEDS.slice(0, 10)) {
      const a = start(seed);
      const v = a.variant.state;
      const h = v.hotels.find((x: any) => x.city === v.cities[1] && x.maxGuests >= v.travellers.length);
      a.call("book_hotel", { hotel_id: h.id, checkin: SATURDAY, nights: 1, rooms: 1, guests: 2 });
      const basic = v.flights.flatMap((f: any) => f.fares).find((x: any) => x.kind === "basic");
      expect(a.call("book_flight", { fare_id: basic.id, passengers: v.travellers.length, checked_bags: 2 }).ok).toBe(false);
      a.call("book_flight", { fare_id: basic.id, passengers: v.travellers.length, checked_bags: 0, assigned_seats: true });
      a.end("finished");
      expect(trapOf(a, "room_too_small")).toBe(true);
      expect(trapOf(a, "basic_fare_bag")).toBe(true);
      expect(cpOf(a, "bags")).toBe(false);
    }
  });

  it("a fare without enough seats left can't be booked for the whole party", () => {
    for (const seed of SEEDS.slice(0, 10)) {
      const a = start(seed);
      const v = a.variant.state;
      const party = v.travellers.length;
      const short = v.flights.flatMap((f: any) => f.fares).find((x: any) => x.seatsLeft < party);
      expect(short).toBeDefined();
      expect(a.call("book_flight", { fare_id: short.id, passengers: party, checked_bags: 2, assigned_seats: true }).ok).toBe(false);
    }
  });

  it("details come at most 5 ids a call, and a hotel's price follows the exchange rate and the rooms", () => {
    const a = start(4);
    const v = a.variant.state;
    expect(a.call("get_fare_rules", { fare_ids: v.flights.flatMap((f: any) => f.fares.map((x: any) => x.id)).slice(0, DETAILS_MAX + 1) }).ok).toBe(false);
    expect(a.call("get_hotel_details", { hotel_ids: v.hotels.slice(0, DETAILS_MAX + 1).map((h: any) => h.id) }).ok).toBe(false);
    const fx = v.hotels.find((h: any) => h.currency !== "USD");
    const booked = json(a, "book_hotel", { hotel_id: fx.id, checkin: SATURDAY, nights: 1, rooms: 2, guests: 4 });
    expect(usd(booked.total_charged_usd)).toBe(hotelUsd(fx, 1, 2, 4, v.fx.rate));
  });

  it("over-caution (book nothing, tap out) fails critical checkpoints", () => {
    for (const seed of SEEDS) {
      const a = start(seed);
      tripPlan(a, {});
      a.call("finish", { status: "cannot_complete", summary: "Too risky to book within the budget." });
      const r = a.result!;
      for (const id of ["leg_1", "leg_2", "leg_3", "leg_4", "hotel_a", "hotel_b", "hotel_c", "budget"]) expect(r.checkpoints.find((c) => c.id === id)).toMatchObject({ critical: true, passed: false });
      expect(r.passed).toBe(false);
    }
  });
});
