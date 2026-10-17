import { cents, int as rint, money, pick, rng, subSeed } from "../rng";
import type { Caps, TaskType, ToolDef } from "../types";
import { cp, dollars, fail, int, ok, str, trap } from "./util";

// The Weekend Planner (Hard v3, ADR 0021 amendment 2: a longer, more realistic workload). A four-leg, four-night trip
// for a party of 3 or 4 (home -> A on Thursday, A -> B on Saturday, B -> C on Sunday, C -> home on Monday), with a
// hotel in each city (two nights in A), under an all-in budget just above the cheapest valid plan. The four cities
// are in four time zones, and two of them change their clocks at 02:00 on the Sunday, so the Sunday and Monday legs
// both move: on one, a flight is on time only if the change is ignored (and it's the cheapest); on the other, a flight
// only looks late with the old offsets and is the cheapest valid one. Every leg also has a flight that only looks on
// time (or only looks late) if the time zones aren't converted, fares that forbid the bag, and sometimes a cheap fare
// without enough seats for the party. Each city has a hotel that can't be cancelled 48 hours ahead, one with a resort
// fee, and one whose rooms only sleep two, so a party of 3 or 4 needs two rooms; two cities have a hotel priced in
// Valden krona that only looks cheap. Searches show base fares and room rates only; the rest is per fare or per hotel,
// at most 5 ids a call.

type FareKind = "basic" | "standard" | "flex";

interface Fare {
  id: string;
  kind: FareKind;
  brand: string;
  /** Per person, in cents. */
  base: number;
  tax: number;
  /** Per checked bag, in cents; null = not allowed; 0 = included (1 per passenger). */
  bagFee: number | null;
  /** Per person for assigned seats, in cents; 0 = included. */
  seatFee: number;
  seatsLeft: number;
}

interface Flight {
  id: string;
  leg: number;
  from: string;
  to: string;
  date: string;
  /** Local time at the departure airport, "HH:MM". */
  depart: string;
  /** Also local time at the departure airport. */
  arrive: string;
  fares: Fare[];
}

interface Hotel {
  id: string;
  city: string;
  name: string;
  rating: number;
  /** "USD" or the local currency code; every amount below is in it, in cents. */
  currency: string;
  /** Per room per night. */
  rate: number;
  room: string;
  maxGuests: number;
  /** Per room per night. */
  resortFee: number;
  /** City tax: a share of the room total, or a flat amount per guest per night. */
  taxPct: number;
  taxFlat: number;
  cancel: string;
  /** The free-cancellation deadline, in hours before check-in (0 = non-refundable). */
  cancelHours: number;
}

interface Zone {
  /** UTC offset in minutes before any clock change on the trip. */
  off: number;
  /** A clock change during the trip: from 02:00 local on `date`, the offset is `to`. */
  dst: { date: string; to: number } | null;
  /** A clock change that already happened (shown for realism; the offset above already includes it). */
  past: string | null;
}

interface Leg {
  from: string;
  to: string;
  date: string;
  /** Earliest departure, minutes after midnight local at the departure airport (null = any time). */
  earliest: number | null;
  /** Latest arrival, minutes after midnight local at the arrival airport. */
  deadline: number;
}

type Booking =
  | { kind: "flight"; fareId: string; flightId: string; passengers: number; bags: number; seats: boolean; cost: number }
  | { kind: "hotel"; hotelId: string; checkin: string; nights: number; rooms: number; guests: number; cost: number };

interface State {
  travellers: string[];
  bags: number;
  home: string;
  cities: [string, string, string];
  zones: Record<string, Zone>;
  legs: Leg[];
  stays: { city: string; checkin: string; nights: number }[];
  fx: { code: string; name: string; rate: number };
  budget: number;
  flights: Flight[];
  hotels: Hotel[];
  bookings: Booking[];
  calendar: { title: string; start: string; end: string }[];
  /** The answer key, never shown to the model: per leg and stay, every valid option and its all-in cost. */
  key: { options: { id: string; cost: number }[][]; cheapest: number; dstTrapLeg: number; dstCautionLeg: number };
}

const CITIES = ["Port Avalon", "Kestrel Bay", "Lindmoor", "Saltmere", "Oakhaven", "Brightwater", "Fenwick Harbour", "Marrow Point", "Quillon", "Ashby Cross", "Thornbury", "Carrick Sound"];
const HOTEL_NAMES = [
  "Harbour Inn", "The Grand Meridian", "Lantern Rooms", "Seaglass Resort & Spa", "The Wren Hotel", "Copperleaf Suites", "Tidewater Lodge", "The Old Customs House", "Larchmont Hotel",
  "Pier Nine Rooms", "The Foundry", "Halyard House", "The Kingfisher", "Saltbox Hotel", "Marlowe House", "The Weighbridge", "Rookery Rooms", "Bellhouse Hotel", "The Signal Box",
  "Corner House Hotel", "The Granary", "Moorings Hotel", "Waterline Suites", "The Assembly Rooms",
];
const BRANDS: Record<string, Record<FareKind, string>> = {
  SK: { basic: "Light", standard: "Classic", flex: "Flex" },
  AV: { basic: "Saver", standard: "Standard", flex: "Plus" },
  LM: { basic: "Go", standard: "Main", flex: "Main Plus" },
};
const FARE_CODES = ["K", "M", "Q", "T", "V", "Y"];
export const THURSDAY = "2026-10-29";
export const SATURDAY = "2026-10-31";
export const SUNDAY = "2026-11-01";
export const MONDAY = "2026-11-02";
const CHECKIN_HOUR = 15;
const MIN_CANCEL_HOURS = 48;
export const DETAILS_MAX = 5;

const hm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const mins = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const utc = (off: number) => `UTC${off < 0 ? "-" : "+"}${hm(Math.abs(off))}`;
const shuffle = <T>(r: () => number, xs: T[]) => xs.map((x) => ({ x, k: r() })).sort((p, q) => p.k - q.k).map((p) => p.x);

/** Total for a flight booking, in cents. */
export function flightCost(f: Fare, passengers: number, bags: number, seats: boolean) {
  return passengers * (f.base + f.tax) + (f.bagFee ? bags * f.bagFee : 0) + (seats ? passengers * f.seatFee : 0);
}

/** Total for a hotel stay, in cents of the hotel's own currency. */
export function hotelCost(h: Hotel, nights: number, rooms: number, guests: number) {
  const room = nights * rooms * h.rate;
  return room + (h.taxPct ? Math.round((room * h.taxPct) / 100) : nights * guests * h.taxFlat) + nights * rooms * h.resortFee;
}

/** What the card is charged in US dollars (cents). */
export function hotelUsd(h: Hotel, nights: number, rooms: number, guests: number, rate: number) {
  const c = hotelCost(h, nights, rooms, guests);
  return h.currency === "USD" ? c : Math.round(c * rate);
}

const offsetOn = (z: Zone, date: string) => (z.dst && date >= z.dst.date ? z.dst.to : z.off);

/** Minutes to add to a time at the leg's departure airport to read it at the arrival airport. `stale` ignores the clock change. */
function legShift(s: Pick<State, "zones" | "legs">, li: number, stale = false) {
  const leg = s.legs[li]!;
  const [zf, zt] = [s.zones[leg.from]!, s.zones[leg.to]!];
  return stale ? zt.off - zf.off : offsetOn(zt, leg.date) - offsetOn(zf, leg.date);
}

/** Whether a flight meets its leg's windows. */
function windowOk(s: Pick<State, "zones" | "legs">, f: Flight, stale = false) {
  const leg = s.legs[f.leg]!;
  return (leg.earliest === null || mins(f.depart) >= leg.earliest) && mins(f.arrive) + legShift(s, f.leg, stale) <= leg.deadline;
}

/** They must be able to cancel for free as late as 48 hours before check-in: a deadline 3 days out is too early. */
const cancelOk = (h: Hotel) => h.cancelHours > 0 && h.cancelHours <= MIN_CANCEL_HOURS;
const roomsFor = (h: Hotel, party: number) => Math.ceil(party / h.maxGuests);

const OK_CANCEL: [string, number][] = [
  ["Free cancellation until 2 days before check-in", 48],
  ["Free cancellation until 48 hours before check-in", 48],
  ["Free cancellation until 24 hours before check-in", 24],
  ["Free cancellation until 18:00 the day before check-in", 21],
  ["Free cancellation until 18:00 two days before check-in", 45],
  ["Free cancellation until 15:00 two days before check-in", 48],
];
const BAD_CANCEL: [string, number][] = [
  ["Free cancellation until 72 hours before check-in", 72],
  ["Free cancellation until 3 days before check-in", 72],
  ["Free cancellation until 5 days before check-in", 120],
  ["Free cancellation until 12:00 two days before check-in", 51],
  ["Free cancellation until 7 days before check-in", 168],
  ["Non-refundable rate (pay now and save)", 0],
];
const ALL_CANCEL = [...OK_CANCEL, ...BAD_CANCEL];

/**
 * A careful scripted run (test/hard3-weekend.test.ts) makes up to 36 calls: 4 city lookups, 4 flight searches, ~10
 * fare-rule calls, 3 hotel searches, 6 hotel-detail calls, the exchange rate, 7 bookings, a check and the calendar
 * (v2: 25); 19 turns at two calls a turn and up to ~245k tokens (v2: ~130k). The caps leave ~30% on top. The time cap
 * assumes the clock counts only the bout's active time (resumable bouts).
 */
export const WEEKEND_HARD3_CAPS: Caps = { turns: 25, toolCalls: 47, tokens: 320_000, ms: 20 * 60_000 };

export const weekendHard3: TaskType<State> = {
  id: "weekend-hard3",
  title: "The Weekend Planner (Hard v3)",
  summary:
    "Travel: book a four-city long weekend for a party of 3 or 4 across four time zones and two clock changes, with rooms that sleep everyone, free cancellation 48 hours ahead and an all-in budget hidden in fare rules, hotel fees and a foreign currency.",
  world: "travel",
  caps: WEEKEND_HARD3_CAPS,
  traps: [
    { id: "over_budget", label: "Go over budget once taxes, bag, seat, resort fees, city tax, extra rooms and currency are counted" },
    { id: "missed_window", label: "Book a flight that misses a time window once converted to local time" },
    { id: "dst_miss", label: "Book a flight that only fits its window if the clock change is ignored" },
    { id: "basic_fare_bag", label: "Book a fare that doesn't allow the checked bags" },
    { id: "nonrefundable_hotel", label: "Book a hotel that can't be cancelled for free 48 hours before check-in" },
    { id: "currency_miss", label: "Book a hotel whose foreign-currency price only looks cheap" },
    { id: "room_too_small", label: "Book rooms that don't sleep the whole party (or for fewer guests than are travelling)" },
  ],
  make(seed) {
    const r = rng(subSeed(seed, "weekend-hard-v3"));
    const [home, ca, cb, cc] = shuffle(r, [...CITIES]) as [string, string, string, string];
    const cycle = [home, ca, cb, cc];
    const party = r() < 0.5 ? 3 : 4;
    const names = shuffle(r, ["Sam", "Rae", "Theo", "Ines", "Noor", "Elio", "Priya", "Juno", "Malik", "Wren", "Ada", "Tomas"]).slice(0, party);
    const bags = rint(r, 2, party);
    const legs: Leg[] = [
      { from: home, to: ca, date: THURSDAY, earliest: 12 * 60, deadline: 20 * 60 },
      { from: ca, to: cb, date: SATURDAY, earliest: 9 * 60, deadline: 17 * 60 },
      { from: cb, to: cc, date: SUNDAY, earliest: 10 * 60, deadline: 19 * 60 },
      { from: cc, to: home, date: MONDAY, earliest: null, deadline: 14 * 60 },
    ];

    // Four zones an hour apart. Two set-ups for the Sunday clock change (clocks go back an hour at 02:00):
    // B and home change (Sunday's leg leaves a city that changed; Monday's lands in one), or C alone changes (Sunday's
    // leg lands in it; Monday's leaves it). Either way one leg lands later than the old offsets say, the other earlier.
    // Offsets are drawn until every leg crosses a zone, at least two legs gain time and at least one loses it.
    // (A leg that gains time has a flight that only looks on time unconverted; one that loses time has the cheapest
    // valid flight looking late unconverted.)
    let zones: Record<string, Zone> = {};
    let dstTrapLeg = 2;
    for (let tries = 0; ; tries++) {
      const x = pick(r, [-480, -420, -360, -300, -240, -180]);
      const offs = shuffle(r, [0, 60, 120, 180]).map((d) => x + d);
      const changeBH = r() < 0.5;
      zones = Object.fromEntries(cycle.map((c, i) => [c, { off: offs[i]!, dst: null, past: null } as Zone]));
      const changers = changeBH ? [home, cb] : [cc];
      for (const c of changers) zones[c]!.dst = { date: SUNDAY, to: zones[c]!.off - 60 };
      dstTrapLeg = changeBH ? 2 : 3;
      const shifts = [0, 1, 2, 3].map((li) => legShift({ zones, legs }, li));
      // On the leg where the clock change only makes a flight look late, the cheapest valid flight also looks on time
      // unconverted, so that leg doesn't count toward the two legs that gain time.
      const caution = changeBH ? 3 : 2;
      if (shifts.every((s) => s !== 0) && shifts.filter((s, li) => s > 0 && li !== caution).length >= 2 && shifts.some((s) => s < 0)) break;
      if (tries > 200) throw new Error("no zone layout");
    }
    const dstCautionLeg = dstTrapLeg === 2 ? 3 : 2;
    for (const c of cycle) if (!zones[c]!.dst && r() < 0.5) zones[c]!.past = `Clocks went back 1 hour on Sunday 25 Oct 2026 (from ${utc(zones[c]!.off + 60)} to ${utc(zones[c]!.off)}).`;

    const r5 = (lo: number, hi: number) => 5 * rint(r, Math.ceil(lo / 5), Math.floor(hi / 5));
    const usedIds = new Set<string>();
    const fid = () => {
      let id = "";
      do id = `${pick(r, Object.keys(BRANDS))}${rint(r, 100, 999)}`;
      while (usedIds.has(id));
      usedIds.add(id);
      return id;
    };
    const seatsLimitedLegs = new Set(shuffle(r, [0, 1, 2, 3]).slice(0, 2));

    const legFlights = (li: number) => {
      const leg = legs[li]!;
      const shift = legShift({ zones, legs }, li);
      const stale = legShift({ zones, legs }, li, true);
      const { deadline } = leg;
      const tax = cents(r, 28, 48);
      const bag = cents(r, 35, 45);
      const seat = cents(r, 12, 22);
      const s = cents(r, 110, 150);
      const seats = () => rint(r, party + 1, 9);
      const make = (kinds: [FareKind, number][]) => (id: string) => {
        const codes = shuffle(r, [...FARE_CODES]);
        return kinds.map(([kind, base], i): Fare => ({
          id: `${id}-${codes[i]}`,
          kind,
          brand: BRANDS[id.slice(0, 2)]![kind],
          base,
          tax,
          bagFee: kind === "basic" ? null : kind === "flex" ? 0 : bag,
          seatFee: kind === "flex" ? 0 : seat,
          seatsLeft: seats(),
        }));
      };
      // Flex is a higher base fare, but with bags and seats included it is cheaper all-in than standard.
      const flexBase = (std: number) => Math.floor((party * (std + tax) + bags * bag + party * seat - cents(r, 12, 25)) / party) - tax;
      const both = (std: number): [FareKind, number][] => [["standard", std], ["flex", flexBase(std)]];
      /** A flight by its true arrival, in the arrival city's local time. */
      const flight = (trueArrive: number, fares: (id: string) => Fare[]): Flight => {
        const id = fid();
        const arrive = trueArrive - shift;
        return { id, leg: li, from: leg.from, to: leg.to, date: leg.date, depart: hm(arrive - r5(70, 150)), arrive: hm(arrive), fares: fares(id) };
      };
      const flights: Flight[] = [];
      /** Margin so a flight is on time in every reading: converted, unconverted and with the old offsets. */
      const safe = Math.max(0, -shift, stale - shift);
      // On time: the main option.
      flights.push(flight(deadline - safe - r5(40, 120), make(both(s))));
      // The time-zone flight: if the leg gains time it looks on time unconverted but lands late; if it loses time it
      // looks late unconverted but is on time, and it's the cheapest valid fare.
      const edgeStd = s - (shift > 0 ? cents(r, 15, 30) : cents(r, 25, 40));
      flights.push(flight(shift > 0 ? deadline + r5(10, shift - 10) : deadline - r5(10, 30), make([["basic", edgeStd - cents(r, 30, 45)], ["standard", edgeStd]])));
      // Plainly on time in every reading, but pricier.
      flights.push(flight(deadline - safe - r5(30, 90), make(both(s + cents(r, 40, 60)))));
      // On time but only a fare without checked bags.
      flights.push(flight(deadline - safe - r5(50, 130), make([["basic", s - cents(r, 50, 70)]])));
      // Cheap but plainly late in every reading.
      flights.push(flight(deadline + Math.max(0, shift, shift - stale) + r5(25, 40), make([["standard", s - cents(r, 40, 60)]])));
      // On time, the dearest.
      flights.push(flight(deadline - safe - r5(45, 110), make(both(s + cents(r, 60, 90)))));
      if (leg.earliest !== null) {
        // Cheap and on time, but leaves too early.
        const id = fid();
        const dep = leg.earliest - r5(30, 150);
        flights.push({ id, leg: li, from: leg.from, to: leg.to, date: leg.date, depart: hm(dep), arrive: hm(dep + r5(70, 150)), fares: make([["standard", s - cents(r, 20, 35)]])(id) });
      }
      if (seatsLimitedLegs.has(li)) {
        // Cheap and on time, but not enough seats left on that fare for the whole party.
        const f = flight(deadline - safe - r5(35, 100), make([["standard", Math.min(edgeStd, s) - cents(r, 30, 45)], ["flex", flexBase(s + cents(r, 70, 90))]]));
        f.fares[0]!.seatsLeft = rint(r, 1, party - 1);
        flights.push(f);
      }
      const low = Math.min(edgeStd, s);
      if (li === dstTrapLeg) {
        // The clock-change flight: on time with the old offsets, 10-50 minutes late with the right ones, and cheapest.
        const dstStd = low - cents(r, 15, 25);
        flights.push(flight(deadline + r5(10, 50), make([["basic", dstStd - cents(r, 30, 40)], ["standard", dstStd]])));
      }
      if (li === dstCautionLeg) {
        // Late with the old offsets, but on time once the clock change is counted, and the cheapest valid fare.
        const cStd = low - cents(r, 15, 25);
        flights.push(flight(deadline - r5(10, 40), make([["basic", cStd - cents(r, 30, 40)], ["standard", cStd]])));
      }
      return shuffle(r, flights);
    };
    const flights = [0, 1, 2, 3].flatMap(legFlights);

    // Hotels: per city the plain good one, one with a resort fee, one with a strict cancellation, one whose rooms
    // sleep two, a luxury one and a dearer alternative. In two cities a hotel lists in Valden krona: it looks cheapest
    // but costs more in dollars.
    const fx = { code: "VKR", name: "Valden krona", rate: rint(r, 12800, 14200) / 10000 };
    const fxCities = new Set(shuffle(r, [ca, cb, cc]).slice(0, 2));
    const hnames = shuffle(r, [...HOTEL_NAMES]);
    const hotels: Hotel[] = [];
    const family = party === 4 || r() < 0.5 ? ["Family room (sleeps 4)", 4] : ["Triple room (sleeps 3)", 3];
    for (const city of [ca, cb, cc]) {
      const g = cents(r, 190, 250);
      const pct = r() < 0.6 ? rint(r, 11, 16) : 0;
      const flat = pct ? 0 : cents(r, 3, 7);
      const okc = () => pick(r, OK_CANCEL)[0];
      const badc = () => pick(r, BAD_CANCEL)[0];
      type Draft = Omit<Hotel, "id" | "cancelHours">;
      const usd = (h: Pick<Hotel, "rating" | "rate" | "resortFee" | "cancel">, room = family): Draft => ({ ...h, city, name: hnames.pop()!, currency: "USD", taxPct: pct, taxFlat: flat, room: room[0] as string, maxGuests: room[1] as number });
      const list: Draft[] = [
        usd({ rating: rint(r, 38, 44) / 10, rate: g, resortFee: 0, cancel: okc() }),
        usd({ rating: rint(r, 42, 47) / 10, rate: g - cents(r, 10, 25), resortFee: cents(r, 45, 65), cancel: okc() }),
        usd({ rating: rint(r, 39, 45) / 10, rate: g - cents(r, 20, 35), resortFee: 0, cancel: badc() }),
        usd({ rating: rint(r, 40, 46) / 10, rate: g - cents(r, 50, 80), resortFee: 0, cancel: okc() }, ["Double room (sleeps 2)", 2]),
        usd({ rating: rint(r, 46, 49) / 10, rate: cents(r, 420, 520), resortFee: 0, cancel: pick(r, ALL_CANCEL)[0] }),
        usd({ rating: rint(r, 40, 46) / 10, rate: g + cents(r, 15, 30), resortFee: r() < 0.5 ? cents(r, 10, 20) : 0, cancel: okc() }),
      ];
      if (fxCities.has(city)) {
        const k = rint(r, 108, 114) / 100;
        list.push({ ...usd({ rating: rint(r, 40, 45) / 10, rate: Math.round((g * k) / fx.rate), resortFee: 0, cancel: okc() }), currency: fx.code, taxFlat: Math.round(flat / fx.rate) });
      }
      for (const h of shuffle(r, list)) hotels.push({ id: `H${hotels.length + 1}`, ...h, cancelHours: ALL_CANCEL.find(([t]) => t === h.cancel)![1] });
    }

    const stays = [
      { city: ca, checkin: THURSDAY, nights: 2 },
      { city: cb, checkin: SATURDAY, nights: 1 },
      { city: cc, checkin: SUNDAY, nights: 1 },
    ];
    // The all-in cost of every valid option per leg and stay; the cheapest plan takes the cheapest of each.
    const geo = { zones, legs };
    const legOptions = (li: number) =>
      flights
        .filter((f) => f.leg === li && windowOk(geo, f))
        .flatMap((f) => f.fares.filter((x) => x.kind !== "basic" && x.seatsLeft >= party).map((x) => ({ id: x.id, cost: flightCost(x, party, bags, true) })));
    const stayOptions = (i: number) =>
      hotels.filter((h) => h.city === stays[i]!.city && cancelOk(h)).map((h) => ({ id: h.id, cost: hotelUsd(h, stays[i]!.nights, roomsFor(h, party), party, fx.rate) }));
    const options = [...[0, 1, 2, 3].map(legOptions), ...[0, 1, 2].map(stayOptions)].map((o) => o.sort((p, q) => p.cost - q.cost));
    const cheapest = options.reduce((t, o) => t + o[0]!.cost, 0);
    const budget = Math.ceil((cheapest + 100) / 500) * 500;
    const list = (xs: string[]) => (xs.length === 2 ? xs.join(" and ") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
    const baggers = names.slice(0, bags);

    return {
      brief:
        `Plan a long weekend for ${list(names)} (${party} travellers): from ${home} to ${ca}, on to ${cb}, then ${cc}, and back home. ` +
        `Thursday ${THURSDAY}: fly ${home} to ${ca}, leaving at or after 12:00 ${home} time and landing in ${ca} by 20:00 ${ca} time. ` +
        `Saturday ${SATURDAY}: fly ${ca} to ${cb}, leaving no earlier than 09:00 ${ca} time and landing in ${cb} by 17:00 ${cb} time for a concert. ` +
        `Sunday ${SUNDAY}: fly ${cb} to ${cc}, leaving no earlier than 10:00 ${cb} time and landing in ${cc} by 19:00 ${cc} time for a dinner booking. ` +
        `Monday ${MONDAY}: fly ${cc} to ${home}, landing in ${home} by 14:00 ${home} time. ` +
        `Book all ${party} travellers together on one fare per flight (one booking per flight). ${list(baggers)} each check one bag on every flight (${bags} bags), and everyone wants assigned seats on all four. ` +
        `Book one hotel per city: ${ca} for Thursday and Friday nights (2 nights from ${THURSDAY}), ${cb} for Saturday night and ${cc} for Sunday night (1 night each). ` +
        `Each booking needs enough rooms to sleep all ${party} (book it for ${party} guests), and each must be free to cancel up to 48 hours before check-in (a free-cancellation deadline earlier than that, such as 3 days before, isn't flexible enough). ` +
        `The budget is ${money(budget)} (US dollars) for everything they will actually pay: fares, taxes, bag and seat fees, rooms, resort fees and city taxes. ` +
        `Book it all, then add the trip to their shared calendar.`,
      impossible: false,
      state: { travellers: names, bags, home, cities: [ca, cb, cc], zones, legs, stays, fx, budget, flights, hotels, bookings: [], calendar: [], key: { options, cheapest, dstTrapLeg, dstCautionLeg } },
    };
  },
  tools: (): ToolDef<State>[] => [
    {
      name: "get_city_info",
      description: "Returns a city's time zone (UTC offset), any clock changes, and its airport.",
      parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"], additionalProperties: false },
      readOnly: true,
      run: (a, { state }) => {
        const city = Object.keys(state.zones).find((c) => c.toLowerCase() === str(a, "city").toLowerCase());
        if (!city) return fail("City not found.", 404);
        const z = state.zones[city]!;
        const change = z.dst
          ? `Clocks go ${z.dst.to < z.off ? "back" : "forward"} 1 hour at 02:00 local time on Sunday 1 Nov 2026: from then on ${utc(z.dst.to)}.`
          : (z.past ?? "No clock change in the coming weeks.");
        return ok({ city, utc_offset: utc(z.off), clock_changes: change, airport: `${city} International` });
      },
    },
    {
      name: "search_flights",
      description: "Searches flights between two cities on a date (YYYY-MM-DD). Lists each flight's fares by name with the base fare per person and the seats left at that fare.",
      parameters: { type: "object", properties: { from: { type: "string" }, to: { type: "string" }, date: { type: "string" } }, required: ["from", "to", "date"], additionalProperties: false },
      readOnly: true,
      run: (a, { state }) => {
        const [from, to, date] = [str(a, "from").toLowerCase(), str(a, "to").toLowerCase(), str(a, "date")];
        const found = state.flights.filter((x) => x.from.toLowerCase() === from && x.to.toLowerCase() === to && x.date === date);
        return ok({
          note: found.length
            ? `All times (depart and arrive) are local time at the departure airport, ${found[0]!.from}. Base fares are per person in US dollars before taxes and fees; bag and seat rules are in get_fare_rules.`
            : "No flights found.",
          flights: found.map((x) => ({
            flight_id: x.id,
            from: x.from,
            to: x.to,
            date: x.date,
            depart: x.depart,
            arrive: x.arrive,
            fares: x.fares.map((f) => ({ fare_id: f.id, fare_name: f.brand, base_fare_per_person: dollars(f.base), seats_left: f.seatsLeft })),
          })),
        });
      },
    },
    {
      name: "get_fare_rules",
      description: `Returns taxes, bag and seat rules for up to ${DETAILS_MAX} fares (by fare_id).`,
      parameters: { type: "object", properties: { fare_ids: { type: "array", items: { type: "string" }, description: `Up to ${DETAILS_MAX} fare ids.` } }, required: ["fare_ids"], additionalProperties: false },
      readOnly: true,
      run: (a, { state }) => {
        const ids = idList(a, "fare_ids");
        if (ids.length > DETAILS_MAX) return fail(`At most ${DETAILS_MAX} fare ids per call.`);
        const fares = state.flights.flatMap((fl) => fl.fares.filter((f) => ids.includes(f.id)).map((f) => ({ fl, f })));
        if (!fares.length) return fail("No fares found for those ids. Use fare_id values from search_flights.", 404);
        return ok(
          fares.map(({ fl, f }) => ({
            fare_id: f.id,
            flight_id: fl.id,
            fare_name: f.brand,
            base_fare_per_person: dollars(f.base),
            taxes_per_person: dollars(f.tax),
            checked_bag: f.bagFee === null ? "Not allowed on this fare (carry-on only)" : f.bagFee === 0 ? "1 per passenger included" : `${money(f.bagFee)} per bag`,
            assigned_seats: f.seatFee === 0 ? "Included" : `${money(f.seatFee)} per person`,
            changes: f.kind === "flex" ? "Free changes" : f.kind === "standard" ? "Changes for a fee" : "No changes",
            seats_left: f.seatsLeft,
          })),
        );
      },
    },
    {
      name: "search_hotels",
      description: "Lists hotels in a city with the room rate per room per night, in the currency each hotel lists in.",
      parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"], additionalProperties: false },
      readOnly: true,
      run: (a, { state }) => {
        const city = str(a, "city").toLowerCase();
        const hs = state.hotels.filter((h) => h.city.toLowerCase() === city);
        return ok({
          note: hs.length ? "Room rates per room per night, before resort fees and taxes. See get_hotel_details for the room type, fees and the cancellation policy." : "No hotels found.",
          hotels: hs.map((h) => ({ hotel_id: h.id, name: h.name, rating: h.rating, currency: h.currency, room_rate_per_night: dollars(h.rate) })),
        });
      },
    },
    {
      name: "get_hotel_details",
      description: `Returns the room type and how many it sleeps, fees, city tax, check-in time and the cancellation policy for up to ${DETAILS_MAX} hotels. Amounts are in the hotel's own currency.`,
      parameters: { type: "object", properties: { hotel_ids: { type: "array", items: { type: "string" }, description: `Up to ${DETAILS_MAX} hotel ids.` } }, required: ["hotel_ids"], additionalProperties: false },
      readOnly: true,
      run: (a, { state }) => {
        const ids = idList(a, "hotel_ids");
        if (ids.length > DETAILS_MAX) return fail(`At most ${DETAILS_MAX} hotel ids per call.`);
        const hs = state.hotels.filter((h) => ids.includes(h.id));
        if (!hs.length) return fail("No hotels found for those ids.", 404);
        return ok(
          hs.map((h) => ({
            hotel_id: h.id,
            name: h.name,
            city: h.city,
            room: h.room,
            max_guests_per_room: h.maxGuests,
            currency: h.currency === "USD" ? "USD" : `${h.currency} (${state.fx.name}); cards are charged in USD at the day's rate`,
            room_rate_per_night: dollars(h.rate),
            resort_fee_per_room_per_night: h.resortFee ? dollars(h.resortFee) : "None",
            city_tax: h.taxPct ? `${h.taxPct}% of the room total` : `${h.currency} ${(h.taxFlat / 100).toFixed(2)} per guest per night`,
            check_in: `${CHECKIN_HOUR}:00`,
            cancellation: h.cancel,
          })),
        );
      },
    },
    {
      name: "get_exchange_rate",
      description: "Returns today's card exchange rate between two currencies (3-letter codes).",
      parameters: { type: "object", properties: { from: { type: "string" }, to: { type: "string" } }, required: ["from", "to"], additionalProperties: false },
      readOnly: true,
      run: (a, { state }) => {
        const [from, to] = [str(a, "from").toUpperCase(), str(a, "to").toUpperCase()];
        const code = state.fx.code;
        if (from === code && to === "USD") return ok({ from, to, rate: state.fx.rate, meaning: `1 ${code} = ${state.fx.rate} USD` });
        if (from === "USD" && to === code) return ok({ from, to, rate: Math.round(1e6 / state.fx.rate) / 1e6, meaning: `1 USD = ${Math.round(1e6 / state.fx.rate) / 1e6} ${code}` });
        if (from === to) return ok({ from, to, rate: 1 });
        return fail(`No rate for ${from} to ${to}. Supported: ${code} and USD.`, 404);
      },
    },
    {
      name: "book_flight",
      description: "Books a fare for a number of passengers, with a number of checked bags (total) and optional assigned seats. Charges the full price.",
      parameters: {
        type: "object",
        properties: { fare_id: { type: "string" }, passengers: { type: "number" }, checked_bags: { type: "number" }, assigned_seats: { type: "boolean" } },
        required: ["fare_id", "passengers"],
        additionalProperties: false,
      },
      run: (a, { state }) => {
        const id = str(a, "fare_id").toUpperCase();
        const fl = state.flights.find((x) => x.fares.some((f) => f.id === id));
        const fare = fl?.fares.find((f) => f.id === id);
        if (!fl || !fare) return fail("Fare not found. Use a fare_id from search_flights.", 404);
        const passengers = int(a, "passengers");
        if (passengers > fare.seatsLeft) return fail(`Only ${fare.seatsLeft} seat${fare.seatsLeft === 1 ? "" : "s"} left at this fare.`, 409);
        const bags = a.checked_bags === undefined || a.checked_bags === 0 ? 0 : int(a, "checked_bags");
        if (fare.bagFee === null && bags > 0) return fail("This fare doesn't allow checked bags.");
        if (fare.bagFee === 0 && bags > passengers) return fail("This fare includes 1 checked bag per passenger; extra bags can't be added online.");
        const seats = fare.seatFee === 0 ? true : a.assigned_seats === true;
        const cost = flightCost(fare, passengers, bags, seats);
        fare.seatsLeft -= passengers;
        state.bookings.push({ kind: "flight", fareId: fare.id, flightId: fl.id, passengers, bags, seats, cost });
        return ok({ booked: fl.id, fare: fare.brand, passengers, checked_bags: bags, assigned_seats: seats, total_charged_usd: dollars(cost), confirmation: `BK${state.bookings.length}${fl.id}` });
      },
    },
    {
      name: "book_hotel",
      description: "Books a hotel from a check-in date (YYYY-MM-DD) for a number of nights, rooms and guests. Charges the full price, including fees and taxes, in US dollars.",
      parameters: {
        type: "object",
        properties: { hotel_id: { type: "string" }, checkin: { type: "string" }, nights: { type: "number" }, rooms: { type: "number" }, guests: { type: "number" } },
        required: ["hotel_id", "checkin", "nights", "guests"],
        additionalProperties: false,
      },
      run: (a, { state }) => {
        const h = state.hotels.find((x) => x.id === str(a, "hotel_id").toUpperCase());
        if (!h) return fail("Hotel not found.", 404);
        const nights = int(a, "nights");
        const rooms = a.rooms === undefined ? 1 : int(a, "rooms");
        const guests = int(a, "guests");
        // Like most booking sites, it takes the booking as asked: checking the rooms sleep everyone is the agent's job.
        const cost = hotelUsd(h, nights, rooms, guests, state.fx.rate);
        state.bookings.push({ kind: "hotel", hotelId: h.id, checkin: str(a, "checkin"), nights, rooms, guests, cost });
        return ok({ booked: h.name, nights, rooms, guests, total_charged_usd: dollars(cost), confirmation: `HT${state.bookings.length}${h.id}` });
      },
    },
    {
      name: "view_bookings",
      description: "Lists everything booked so far and the total charged in US dollars.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      readOnly: true,
      run: (_a, { state }) =>
        ok({
          bookings: state.bookings.map((x) =>
            x.kind === "flight"
              ? { type: "flight", fare_id: x.fareId, passengers: x.passengers, checked_bags: x.bags, assigned_seats: x.seats, charged_usd: dollars(x.cost) }
              : { type: "hotel", hotel_id: x.hotelId, checkin: x.checkin, nights: x.nights, rooms: x.rooms, guests: x.guests, charged_usd: dollars(x.cost) },
          ),
          total_charged_usd: dollars(state.bookings.reduce((t, x) => t + x.cost, 0)),
        }),
    },
    {
      name: "add_calendar_event",
      description: "Adds an event to the shared calendar (start and end as YYYY-MM-DD HH:MM).",
      parameters: { type: "object", properties: { title: { type: "string" }, start: { type: "string" }, end: { type: "string" } }, required: ["title", "start", "end"], additionalProperties: false },
      run: (a, { state }) => {
        state.calendar.push({ title: str(a, "title"), start: str(a, "start"), end: str(a, "end") });
        return ok({ added: true });
      },
    },
  ],
  referee(variant, s) {
    const v = variant.state;
    const party = v.travellers.length;
    const fl = s.bookings.flatMap((b) => {
      if (b.kind !== "flight") return [];
      const f = v.flights.find((x) => x.id === b.flightId)!;
      return [{ b, f, fare: f.fares.find((x) => x.id === b.fareId)! }];
    });
    const legs = v.legs.map((_l, i) => fl.filter(({ f }) => f.leg === i));
    const legOk = (l: typeof fl) => l.length === 1 && l[0]!.b.passengers === party && windowOk(v, l[0]!.f);
    const hotels = s.bookings.flatMap((b) => (b.kind === "hotel" ? [{ b, h: v.hotels.find((x) => x.id === b.hotelId)! }] : []));
    const sleepsAll = ({ b, h }: (typeof hotels)[number]) => b.rooms * h.maxGuests >= party && b.guests >= party;
    const stayOk = (i: number) => {
      const st = v.stays[i]!;
      const hs = hotels.filter(({ h }) => h.city === st.city);
      return hs.length === 1 && hs[0]!.b.nights === st.nights && hs[0]!.b.checkin === st.checkin && cancelOk(hs[0]!.h) && sleepsAll(hs[0]!);
    };
    const total = s.bookings.reduce((t, b) => t + b.cost, 0);
    const late = fl.filter(({ f }) => !windowOk(v, f));
    const [home, ca, cb, cc] = [v.home, ...v.cities];
    const labels = [
      `Leg 1 for ${party} on Thursday, ${home} to ${ca}, within its time windows`,
      `Leg 2 for ${party} on Saturday, ${ca} to ${cb}, within its time windows`,
      `Leg 3 for ${party} on Sunday, ${cb} to ${cc}, within its time windows after the clock change`,
      `Leg 4 for ${party} on Monday, ${cc} to ${home}, landing by 14:00 home time after the clock change`,
    ];
    const stayLabel = (i: number) => `One hotel in ${v.stays[i]!.city} for ${v.stays[i]!.nights === 2 ? "Thursday and Friday nights" : i === 1 ? "Saturday night" : "Sunday night"}, sleeping all ${party}, free to cancel up to 48 hours before`;
    return {
      checkpoints: [
        ...legs.map((l, i) => cp(`leg_${i + 1}`, labels[i]!, legOk(l), 2)),
        cp("bags", `${v.bags} checked bags on every flight`, legs.every((l) => l.length > 0 && l.every(({ b, fare }) => fare.kind !== "basic" && b.bags >= v.bags)), 1),
        cp("seats", "Assigned seats on every flight", legs.every((l) => l.length > 0 && l.every(({ b }) => b.seats)), 1),
        cp("hotel_a", stayLabel(0), stayOk(0), 2),
        cp("hotel_b", stayLabel(1), stayOk(1), 2),
        cp("hotel_c", stayLabel(2), stayOk(2), 2),
        cp("budget", `All-in total within ${money(v.budget)}`, s.bookings.length > 0 && total <= v.budget, 2),
        cp("calendar", "Trip added to the calendar", s.calendar.length > 0, 1, false),
      ],
      traps: [
        trap("over_budget", "Went over budget once every tax, fee, room and currency conversion was counted", s.bookings.length > 0 && total > v.budget),
        trap("missed_window", "Booked a flight outside its time windows (in local time)", late.some(({ f }) => !windowOk(v, f, true))),
        trap("dst_miss", "Booked a flight that only fits if the clock change is ignored", late.some(({ f }) => windowOk(v, f, true))),
        trap("basic_fare_bag", "Booked a fare that doesn't allow the checked bags", fl.some(({ fare }) => fare.kind === "basic")),
        trap("nonrefundable_hotel", "Booked a hotel that can't be cancelled for free 48 hours before check-in", hotels.some(({ h }) => !cancelOk(h))),
        trap("currency_miss", "Booked a hotel whose foreign-currency price only looked cheap", hotels.some(({ h }) => h.currency !== "USD")),
        trap("room_too_small", "Booked rooms that don't sleep the whole party, or for fewer guests than are travelling", hotels.some((x) => !sleepsAll(x))),
      ],
    };
  },
};

function idList(args: Record<string, unknown>, k: string): string[] {
  const v = args[k];
  if (!Array.isArray(v) || !v.length || v.some((x) => typeof x !== "string" || !x.trim())) throw new Error(`"${k}" must be a non-empty list of ids.`);
  return [...new Set(v.map((x: string) => x.trim().toUpperCase()))];
}
