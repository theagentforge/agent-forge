import { cents, int as rint, money, pick, rng, subSeed } from "../rng";
import type { Caps, TaskType, ToolDef } from "../types";
import { weekend } from "./weekend";
import { cp, dollars, fail, int, ok, str, trap } from "./util";

// The Weekend Planner (Hard v2): a three-leg trip for two (home -> city A on Friday, A -> B on Saturday, B -> home on
// Sunday) and a hotel in each city, under an all-in budget just above the cheapest valid plan. The three cities are
// in three time zones and one of them changes its clocks at 02:00 on the Sunday. Flight times are local at the
// departure airport; deadlines are local where they land. Searches show base fares and nightly rates only; bag and
// seat rules, taxes, resort fees, city tax and cancellation are per fare or per hotel, at most 5 ids a call. One
// hotel lists its prices in Valden krona, converted at a rate from a tool. Per leg one flight looks on time but
// lands late (or looks late but is the cheapest valid), one is on time only if the clock change is ignored, fare
// brands hide which fares forbid the bag, and the cheapest hotels carry resort fees, a strict cancellation policy
// or a foreign price that only looks low.

type FareKind = "basic" | "standard" | "flex";

interface Fare {
  id: string;
  kind: FareKind;
  /** The airline's brand name for the fare ("Light", "Saver", ...). */
  brand: string;
  /** Per person, in cents. */
  base: number;
  tax: number;
  /** Per checked bag, in cents; null = not allowed; 0 = included (1 per passenger). */
  bagFee: number | null;
  /** Per person for assigned seats, in cents; 0 = included. */
  seatFee: number;
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
  rate: number;
  resortFee: number;
  /** City tax: a share of the room rate, or a flat amount per person per night. */
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
  | { kind: "hotel"; hotelId: string; checkin: string; nights: number; cost: number };

interface State {
  travellers: string[];
  home: string;
  cities: [string, string];
  zones: Record<string, Zone>;
  legs: Leg[];
  /** Hotel nights: city A on Friday, city B on Saturday. */
  stays: { city: string; checkin: string }[];
  fx: { code: string; name: string; rate: number };
  budget: number;
  flights: Flight[];
  hotels: Hotel[];
  bookings: Booking[];
  calendar: { title: string; start: string; end: string }[];
  /** The answer key, never shown to the model: every in-budget combination [leg 1, leg 2, leg 3 fares, hotel A, hotel B]. */
  key: { valid: string[][]; cheapest: number };
}

const CITIES = ["Port Avalon", "Kestrel Bay", "Lindmoor", "Saltmere", "Oakhaven", "Brightwater", "Fenwick Harbour", "Marrow Point", "Quillon", "Ashby Cross"];
const HOTEL_NAMES = ["Harbour Inn", "The Grand Meridian", "Lantern Rooms", "Seaglass Resort & Spa", "The Wren Hotel", "Copperleaf Suites", "Tidewater Lodge", "The Old Customs House", "Larchmont Hotel", "Pier Nine Rooms", "The Foundry", "Halyard House"];
const BRANDS: Record<string, Record<FareKind, string>> = {
  SK: { basic: "Light", standard: "Classic", flex: "Flex" },
  AV: { basic: "Saver", standard: "Standard", flex: "Plus" },
  LM: { basic: "Go", standard: "Main", flex: "Main Plus" },
};
const FARE_CODES = ["K", "M", "Q", "T", "V", "Y"];
const FRIDAY = "2026-10-30";
const SATURDAY = "2026-10-31";
const SUNDAY = "2026-11-01";
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

/** Total for a hotel stay for two, in cents of the hotel's own currency. */
export function hotelCost(h: Hotel, nights: number) {
  const room = nights * h.rate;
  return room + (h.taxPct ? Math.round((room * h.taxPct) / 100) : nights * 2 * h.taxFlat) + nights * h.resortFee;
}

/** What the card is charged in US dollars (cents). */
export function hotelUsd(h: Hotel, nights: number, rate: number) {
  const c = hotelCost(h, nights);
  return h.currency === "USD" ? c : Math.round(c * rate);
}

const offsetOn = (z: Zone, date: string) => (z.dst && date >= z.dst.date ? z.dst.to : z.off);

/** Whether a flight meets its leg's windows. `stale` reads every city's offset as it was before the clock change. */
function windowOk(s: Pick<State, "zones" | "legs">, f: Flight, stale = false) {
  const leg = s.legs[f.leg]!;
  const [zf, zt] = [s.zones[f.from]!, s.zones[f.to]!];
  const shift = stale ? zt.off - zf.off : offsetOn(zt, f.date) - offsetOn(zf, f.date);
  return (leg.earliest === null || mins(f.depart) >= leg.earliest) && mins(f.arrive) + shift <= leg.deadline;
}

/** They must be able to cancel for free as late as 48 hours before check-in: a deadline 3 days out is too early. */
const cancelOk = (h: Hotel) => h.cancelHours > 0 && h.cancelHours <= MIN_CANCEL_HOURS;

const OK_CANCEL: [string, number][] = [
  ["Free cancellation until 2 days before check-in", 48],
  ["Free cancellation until 48 hours before check-in", 48],
  ["Free cancellation until 24 hours before check-in", 24],
  ["Free cancellation until 18:00 the day before check-in", 21],
  ["Free cancellation until 18:00 two days before check-in", 45],
];
const BAD_CANCEL: [string, number][] = [
  ["Free cancellation until 72 hours before check-in", 72],
  ["Free cancellation until 3 days before check-in", 72],
  ["Free cancellation until 5 days before check-in", 120],
  ["Free cancellation until 12:00 two days before check-in", 51],
  ["Non-refundable rate (pay now and save)", 0],
];

/**
 * A careful scripted run makes 25 calls: 3 city lookups, 3 searches, 6 fare-rule calls (5 fares each), 2 hotel
 * searches, 4 hotel-detail calls, the exchange rate, 5 bookings, a check and the calendar; 14 turns at two calls a
 * turn and ~130k tokens. The caps leave ~30% on top (the test checks it on every seed).
 */
export const WEEKEND_HARD_CAPS: Caps = { turns: 20, toolCalls: 34, tokens: 240_000, ms: 10 * 60_000 };

export const weekendHard: TaskType<State> = {
  id: "weekend-hard",
  title: `${weekend.title} (Hard)`,
  summary: "Travel: book a three-city weekend for two across three time zones and a clock change, under an all-in budget hidden in fare rules, hotel fees and a foreign currency.",
  world: "travel",
  caps: WEEKEND_HARD_CAPS,
  traps: [
    { id: "over_budget", label: "Go over budget once taxes, bag, seat, resort fees, city tax and currency are counted" },
    { id: "missed_window", label: "Book a flight that misses a time window once converted to local time" },
    { id: "dst_miss", label: "Book a flight that only fits its window if the clock change is ignored" },
    { id: "basic_fare_bag", label: "Book a fare that doesn't allow the checked bag" },
    { id: "nonrefundable_hotel", label: "Book a hotel that can't be cancelled for free 48 hours before check-in" },
    { id: "currency_miss", label: "Book the hotel whose foreign-currency price only looks cheap" },
  ],
  make(seed) {
    const r = rng(subSeed(seed, "weekend-hard-v2"));
    const [home, ca, cb] = shuffle(r, [...CITIES]) as [string, string, string];
    // Three zones an hour apart. Only orders where some leg gains time and some leg loses it (after the change).
    const x = pick(r, [-480, -420, -360, -300, -240]);
    const [oh, oa, ob] = pick(r, [[0, 60, 120], [60, 120, 0], [120, 0, 60]] as const).map((d) => x + d) as [number, number, number];
    const backAtB = r() < 0.5;
    const zones: Record<string, Zone> = {
      [home]: { off: oh, dst: backAtB ? null : { date: SUNDAY, to: oh + 60 }, past: null },
      [ca]: { off: oa, dst: null, past: r() < 0.5 ? `Clocks went back 1 hour on Sunday 25 Oct 2026 (from ${utc(oa + 60)} to ${utc(oa)}).` : null },
      [cb]: { off: ob, dst: backAtB ? { date: SUNDAY, to: ob - 60 } : null, past: null },
    };
    const legs: Leg[] = [
      { from: home, to: ca, date: FRIDAY, earliest: 12 * 60, deadline: 20 * 60 },
      { from: ca, to: cb, date: SATURDAY, earliest: 10 * 60, deadline: 18 * 60 },
      { from: cb, to: home, date: SUNDAY, earliest: null, deadline: 21 * 60 },
    ];
    const a = pick(r, ["Sam", "Rae", "Theo", "Ines", "Noor", "Elio"]);
    const b = pick(r, ["Priya", "Juno", "Malik", "Wren", "Ada", "Tomas"]);
    const r5 = (lo: number, hi: number) => 5 * rint(r, lo / 5, hi / 5);
    const usedIds = new Set<string>();
    const fid = () => {
      let id = "";
      do id = `${pick(r, Object.keys(BRANDS))}${rint(r, 100, 999)}`;
      while (usedIds.has(id));
      usedIds.add(id);
      return id;
    };

    const legFlights = (li: number) => {
      const leg = legs[li]!;
      const shift = offsetOn(zones[leg.to]!, leg.date) - offsetOn(zones[leg.from]!, leg.date);
      const { deadline } = leg;
      const tax = cents(r, 28, 48);
      const bag = cents(r, 35, 45);
      const seat = cents(r, 12, 22);
      const s = cents(r, 110, 150);
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
        }));
      };
      // Flex is a higher base fare, but with bag and seats included it is cheaper all-in than standard.
      const flexBase = (stdBase: number) => Math.floor((2 * (stdBase + tax) + bag + 2 * seat - cents(r, 12, 25)) / 2) - tax;
      const both = (std: number): [FareKind, number][] => [["standard", std], ["flex", flexBase(std)]];
      /** A flight by its true arrival, in the arrival city's local time. */
      const flight = (trueArrive: number, fares: (id: string) => Fare[]): Flight => {
        const id = fid();
        const arrive = trueArrive - shift;
        return { id, leg: li, from: leg.from, to: leg.to, date: leg.date, depart: hm(arrive - r5(70, 150)), arrive: hm(arrive), fares: fares(id) };
      };
      const flights: Flight[] = [];
      // On time: the main option.
      flights.push(flight(deadline - r5(40, 120), make(both(s))));
      // The time-zone flight: if the leg gains time it looks on time but lands late; if it loses time it looks late
      // but is on time, and it's the cheapest valid fare.
      const edgeStd = s - (shift > 0 ? cents(r, 15, 30) : cents(r, 25, 40));
      flights.push(flight(shift > 0 ? deadline + r5(10, shift - 10) : deadline - r5(10, 30), make([["basic", edgeStd - cents(r, 30, 45)], ["standard", edgeStd]])));
      // Plainly on time in either reading, but pricier.
      const s3 = s + cents(r, 40, 60);
      flights.push(flight(deadline - Math.max(0, -shift) - r5(30, 90), make(both(s3))));
      // On time but only a fare without a checked bag.
      flights.push(flight(deadline - r5(50, 130), make([["basic", s - cents(r, 50, 70)]])));
      // Cheap but plainly late (even before any clock change).
      flights.push(flight(deadline + Math.max(shift, 60) + r5(25, 40), make([["standard", s - cents(r, 40, 60)]])));
      // On time, the dearest.
      flights.push(flight(deadline - r5(45, 110), make(both(s + cents(r, 60, 90)))));
      if (leg.earliest !== null) {
        // Cheap and on time, but leaves too early.
        const id = fid();
        const dep = leg.earliest - r5(30, 150);
        const arr = dep + r5(70, 150);
        flights.push({ id, leg: li, from: leg.from, to: leg.to, date: leg.date, depart: hm(dep), arrive: hm(arr), fares: make([["standard", s - cents(r, 20, 35)]])(id) });
      } else {
        // The clock-change flight: on time with the old offsets, up to 50 minutes late with the right ones, and cheapest.
        const dstStd = Math.min(edgeStd, s) - cents(r, 15, 25);
        flights.push(flight(deadline + r5(10, 50), make([["basic", dstStd - cents(r, 30, 40)], ["standard", dstStd]])));
      }
      return shuffle(r, flights);
    };
    const flights = [0, 1, 2].flatMap(legFlights);

    // Hotels: per city the plain good one, one with a resort fee, one with a strict cancellation, a luxury one and a
    // dearer alternative. In one city a hotel lists in Valden krona: it looks cheapest but costs more in dollars.
    const fx = { code: "VKR", name: "Valden krona", rate: rint(r, 12800, 14200) / 10000 };
    const fxCity = r() < 0.5 ? ca : cb;
    const names = shuffle(r, [...HOTEL_NAMES]);
    const hotels: Hotel[] = [];
    for (const city of [ca, cb]) {
      const g = cents(r, 140, 180);
      const pct = r() < 0.6 ? rint(r, 11, 16) : 0;
      const flat = pct ? 0 : cents(r, 3, 7);
      const okc = () => pick(r, OK_CANCEL);
      const badc = () => pick(r, BAD_CANCEL);
      const usd = (h: Omit<Hotel, "id" | "city" | "name" | "currency" | "taxPct" | "taxFlat">) => ({ ...h, city, name: names.pop()!, currency: "USD", taxPct: pct, taxFlat: flat });
      const list = [
        usd({ rating: rint(r, 38, 44) / 10, rate: g, resortFee: 0, cancel: okc()[0], cancelHours: 0 }),
        usd({ rating: rint(r, 42, 47) / 10, rate: g - cents(r, 10, 25), resortFee: cents(r, 45, 65), cancel: okc()[0], cancelHours: 0 }),
        usd({ rating: rint(r, 39, 45) / 10, rate: g - cents(r, 20, 35), resortFee: 0, cancel: badc()[0], cancelHours: 0 }),
        usd({ rating: rint(r, 46, 49) / 10, rate: cents(r, 330, 420), resortFee: 0, cancel: pick(r, [...OK_CANCEL, ...BAD_CANCEL])[0], cancelHours: 0 }),
        usd({ rating: rint(r, 40, 46) / 10, rate: g + cents(r, 15, 30), resortFee: r() < 0.5 ? cents(r, 10, 20) : 0, cancel: okc()[0], cancelHours: 0 }),
      ];
      if (city === fxCity) {
        const k = rint(r, 108, 114) / 100;
        list.push({ ...usd({ rating: rint(r, 40, 45) / 10, rate: Math.round((g * k) / fx.rate), resortFee: 0, cancel: okc()[0], cancelHours: 0 }), currency: fx.code, taxFlat: Math.round(flat / fx.rate) });
      }
      const all = [...OK_CANCEL, ...BAD_CANCEL];
      for (const h of shuffle(r, list)) hotels.push({ id: `H${hotels.length + 1}`, ...h, cancelHours: all.find(([t]) => t === h.cancel)![1] });
    }

    // The all-in cost of every combination that meets every rule, for the budget and the answer key.
    const geo = { zones, legs };
    const legOptions = (li: number) =>
      flights.filter((f) => f.leg === li && windowOk(geo, f)).flatMap((f) => f.fares.filter((x) => x.kind !== "basic").map((x) => ({ id: x.id, cost: flightCost(x, 2, 1, true) })));
    const stays = [
      { city: ca, checkin: FRIDAY },
      { city: cb, checkin: SATURDAY },
    ];
    const hotelOptions = (city: string) => hotels.filter((h) => h.city === city && cancelOk(h)).map((h) => ({ id: h.id, cost: hotelUsd(h, 1, fx.rate) }));
    const slots = [legOptions(0), legOptions(1), legOptions(2), hotelOptions(ca), hotelOptions(cb)];
    let combos: { ids: string[]; cost: number }[] = [{ ids: [], cost: 0 }];
    for (const slot of slots) combos = combos.flatMap((c) => slot.map((o) => ({ ids: [...c.ids, o.id], cost: c.cost + o.cost })));
    const cheapest = Math.min(...combos.map((c) => c.cost));
    const budget = Math.ceil((cheapest + 100) / 500) * 500;
    const valid = combos.filter((c) => c.cost <= budget).map((c) => c.ids);

    return {
      brief:
        `Plan a long weekend for ${a} and ${b}: from ${home} to ${ca}, on to ${cb}, and back home. ` +
        `Friday ${FRIDAY}: fly ${home} to ${ca}, leaving at or after 12:00 ${home} time (${a} works until noon) and landing in ${ca} by 20:00 ${ca} time for a dinner booking. ` +
        `Saturday ${SATURDAY}: fly ${ca} to ${cb}, leaving no earlier than 10:00 ${ca} time and landing in ${cb} by 18:00 ${cb} time for a concert. ` +
        `Sunday ${SUNDAY}: fly ${cb} to ${home}, landing in ${home} by 21:00 ${home} time. ` +
        `${b} checks one bag on every flight, and they want assigned seats together on all three. ` +
        `Book one hotel in ${ca} for Friday night and one in ${cb} for Saturday night (1 night each), each one they can still cancel for free up to 48 hours before check-in (a free-cancellation deadline earlier than that, such as 3 days before, isn't flexible enough). ` +
        `The budget is ${money(budget)} (US dollars) for everything they will actually pay: fares, taxes, bag and seat fees, rooms, resort fees and city taxes. ` +
        `Book it all, then add the trip to their shared calendar.`,
      impossible: false,
      state: { travellers: [a, b], home, cities: [ca, cb], zones, legs, stays, fx, budget, flights, hotels, bookings: [], calendar: [], key: { valid, cheapest } },
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
      description: "Searches flights between two cities on a date (YYYY-MM-DD). Lists each flight's fares by name with the base fare per person.",
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
            fares: x.fares.map((f) => ({ fare_id: f.id, fare_name: f.brand, base_fare_per_person: dollars(f.base) })),
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
          })),
        );
      },
    },
    {
      name: "search_hotels",
      description: "Lists hotels in a city with the room rate per night, in the currency each hotel lists in.",
      parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"], additionalProperties: false },
      readOnly: true,
      run: (a, { state }) => {
        const city = str(a, "city").toLowerCase();
        const hs = state.hotels.filter((h) => h.city.toLowerCase() === city);
        return ok({
          note: hs.length ? "Room rates per night for two, before resort fees and taxes. See get_hotel_details for fees and the cancellation policy." : "No hotels found.",
          hotels: hs.map((h) => ({ hotel_id: h.id, name: h.name, rating: h.rating, currency: h.currency, room_rate_per_night: dollars(h.rate) })),
        });
      },
    },
    {
      name: "get_hotel_details",
      description: `Returns fees, city tax, check-in time and the cancellation policy for up to ${DETAILS_MAX} hotels. Amounts are in the hotel's own currency.`,
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
            currency: h.currency === "USD" ? "USD" : `${h.currency} (${state.fx.name}); cards are charged in USD at the day's rate`,
            room_rate_per_night: dollars(h.rate),
            resort_fee_per_night: h.resortFee ? dollars(h.resortFee) : "None",
            city_tax: h.taxPct ? `${h.taxPct}% of the room rate` : `${h.currency} ${(h.taxFlat / 100).toFixed(2)} per person per night`,
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
        const bags = a.checked_bags === undefined || a.checked_bags === 0 ? 0 : int(a, "checked_bags");
        if (fare.bagFee === null && bags > 0) return fail("This fare doesn't allow checked bags.");
        if (fare.bagFee === 0 && bags > passengers) return fail("This fare includes 1 checked bag per passenger; extra bags can't be added online.");
        const seats = fare.seatFee === 0 ? true : a.assigned_seats === true;
        const cost = flightCost(fare, passengers, bags, seats);
        state.bookings.push({ kind: "flight", fareId: fare.id, flightId: fl.id, passengers, bags, seats, cost });
        return ok({ booked: fl.id, fare: fare.brand, passengers, checked_bags: bags, assigned_seats: seats, total_charged_usd: dollars(cost), confirmation: `BK${state.bookings.length}${fl.id}` });
      },
    },
    {
      name: "book_hotel",
      description: "Books a hotel from a check-in date (YYYY-MM-DD) for a number of nights. Charges the full price, including fees and taxes, in US dollars.",
      parameters: { type: "object", properties: { hotel_id: { type: "string" }, checkin: { type: "string" }, nights: { type: "number" } }, required: ["hotel_id", "checkin", "nights"], additionalProperties: false },
      run: (a, { state }) => {
        const h = state.hotels.find((x) => x.id === str(a, "hotel_id").toUpperCase());
        if (!h) return fail("Hotel not found.", 404);
        const nights = int(a, "nights");
        const cost = hotelUsd(h, nights, state.fx.rate);
        state.bookings.push({ kind: "hotel", hotelId: h.id, checkin: str(a, "checkin"), nights, cost });
        return ok({ booked: h.name, nights, total_charged_usd: dollars(cost), confirmation: `HT${state.bookings.length}${h.id}` });
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
              : { type: "hotel", hotel_id: x.hotelId, checkin: x.checkin, nights: x.nights, charged_usd: dollars(x.cost) },
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
    const fl = s.bookings.flatMap((b) => {
      if (b.kind !== "flight") return [];
      const f = v.flights.find((x) => x.id === b.flightId)!;
      return [{ b, f, fare: f.fares.find((x) => x.id === b.fareId)! }];
    });
    const legs = v.legs.map((_l, i) => fl.filter(({ f }) => f.leg === i));
    const legOk = (l: typeof fl) => l.length === 1 && l[0]!.b.passengers === 2 && windowOk(v, l[0]!.f);
    const hotels = s.bookings.flatMap((b) => (b.kind === "hotel" ? [{ b, h: v.hotels.find((x) => x.id === b.hotelId)! }] : []));
    const stayOk = (i: number) => {
      const st = v.stays[i]!;
      const hs = hotels.filter(({ h }) => h.city === st.city);
      return hs.length === 1 && hs[0]!.b.nights === 1 && hs[0]!.b.checkin === st.checkin && cancelOk(hs[0]!.h);
    };
    const total = s.bookings.reduce((t, b) => t + b.cost, 0);
    const late = fl.filter(({ f }) => !windowOk(v, f));
    const labels = [
      `Leg 1 for 2 on Friday, ${v.home} to ${v.cities[0]}, within its time windows`,
      `Leg 2 for 2 on Saturday, ${v.cities[0]} to ${v.cities[1]}, within its time windows`,
      `Leg 3 for 2 on Sunday, ${v.cities[1]} to ${v.home}, landing by 21:00 home time after the clock change`,
    ];
    return {
      checkpoints: [
        ...legs.map((l, i) => cp(`leg_${i + 1}`, labels[i]!, legOk(l), 2)),
        cp("bag", "A checked bag on every flight", legs.every((l) => l.length > 0 && l.every(({ b, fare }) => fare.kind !== "basic" && b.bags >= 1)), 1),
        cp("seats", "Assigned seats on every flight", legs.every((l) => l.length > 0 && l.every(({ b }) => b.seats)), 1),
        cp("hotel_a", `One hotel in ${v.cities[0]} for Friday night, free to cancel up to 48 hours before`, stayOk(0), 2),
        cp("hotel_b", `One hotel in ${v.cities[1]} for Saturday night, free to cancel up to 48 hours before`, stayOk(1), 2),
        cp("budget", `All-in total within ${money(v.budget)}`, s.bookings.length > 0 && total <= v.budget, 2),
        cp("calendar", "Trip added to the calendar", s.calendar.length > 0, 1, false),
      ],
      traps: [
        trap("over_budget", "Went over budget once every tax, fee and currency conversion was counted", s.bookings.length > 0 && total > v.budget),
        trap("missed_window", "Booked a flight outside its time windows (in local time)", late.some(({ f }) => !windowOk(v, f, true))),
        trap("dst_miss", "Booked a flight that only fits if the clock change is ignored", late.some(({ f }) => windowOk(v, f, true))),
        trap("basic_fare_bag", "Booked a fare that doesn't allow the checked bag", fl.some(({ fare }) => fare.kind === "basic")),
        trap("nonrefundable_hotel", "Booked a hotel that can't be cancelled for free 48 hours before check-in", hotels.some(({ h }) => !cancelOk(h))),
        trap("currency_miss", "Booked the hotel whose foreign-currency price only looked cheap", hotels.some(({ h }) => h.currency !== "USD")),
      ],
    };
  },
};

function idList(args: Record<string, unknown>, k: string): string[] {
  const v = args[k];
  if (!Array.isArray(v) || !v.length || v.some((x) => typeof x !== "string" || !x.trim())) throw new Error(`"${k}" must be a non-empty list of ids.`);
  return [...new Set(v.map((x: string) => x.trim().toUpperCase()))];
}
