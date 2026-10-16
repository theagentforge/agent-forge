import { cents, int as rint, money, pick, rng, subSeed } from "../rng";
import type { TaskType, ToolDef } from "../types";
import { cp, dollars, fail, int, ok, str, trap } from "./util";

// The Weekend Planner: book flights and a hotel for two people inside time windows and a budget. The cheapest
// flights are basic fares with no checked bag, though one traveller needs a bag.

interface Flight {
  id: string;
  from: string;
  to: string;
  date: string;
  depart: string;
  arrive: string;
  pricePerPerson: number;
  fare: "basic" | "standard";
  checkedBag: boolean;
}

interface Hotel {
  id: string;
  city: string;
  name: string;
  perNight: number;
}

interface State {
  travellers: string[];
  home: string;
  dest: string;
  friday: string;
  sunday: string;
  budget: number;
  flights: Flight[];
  hotels: Hotel[];
  bookings: { kind: "flight" | "hotel"; id: string; passengers?: number; nights?: number; checkin?: string; cost: number }[];
  calendar: { title: string; start: string; end: string }[];
}

const CITIES = ["Port Avalon", "Kestrel Bay", "Lindmoor", "Saltmere", "Oakhaven", "Brightwater"];

export const weekend: TaskType<State> = {
  id: "weekend",
  title: "The Weekend Planner",
  summary: "Travel: book flights and a hotel for two inside time windows and a budget, then add it to the calendar.",
  world: "travel",
  traps: [
    { id: "no_bag", label: "Book a basic fare that doesn't include the checked bag one traveller needs" },
    { id: "bad_time", label: "Book a flight outside the time windows" },
  ],
  make(seed) {
    const r = rng(subSeed(seed, "weekend"));
    const [home, dest] = [...CITIES].sort(() => r() - 0.5) as [string, string];
    const a = pick(r, ["Sam", "Rae", "Theo", "Ines"]);
    const b = pick(r, ["Priya", "Juno", "Malik", "Wren"]);
    const friday = "2026-10-30";
    const sunday = "2026-11-01";
    const f = (id: string, from: string, to: string, date: string, dep: number, dur: number, price: number, fare: Flight["fare"]): Flight => ({
      id,
      from,
      to,
      date,
      depart: `${String(dep).padStart(2, "0")}:${pick(r, ["05", "20", "40"])}`,
      arrive: `${String(dep + dur).padStart(2, "0")}:${pick(r, ["10", "35", "50"])}`,
      pricePerPerson: price,
      fare,
      checkedBag: fare === "standard",
    });
    const outGood = f(`FA${rint(r, 100, 499)}`, home, dest, friday, 18, 2, cents(r, 90, 140), "standard");
    const outEarly = f(`FA${rint(r, 500, 599)}`, home, dest, friday, 13, 2, cents(r, 70, 85), "standard");
    const outBasic = f(`FA${rint(r, 600, 699)}`, home, dest, friday, 19, 2, cents(r, 45, 60), "basic");
    const backGood = f(`FA${rint(r, 700, 799)}`, dest, home, sunday, 17, 2, cents(r, 90, 140), "standard");
    const backLate = f(`FA${rint(r, 800, 849)}`, dest, home, sunday, 21, 2, cents(r, 60, 80), "standard");
    const backBasic = f(`FA${rint(r, 850, 899)}`, dest, home, sunday, 16, 2, cents(r, 45, 60), "basic");
    const hotels: Hotel[] = [
      { id: "H1", city: dest, name: "Harbour Inn", perNight: cents(r, 110, 150) },
      { id: "H2", city: dest, name: "The Grand Meridian", perNight: cents(r, 320, 420) },
      { id: "H3", city: dest, name: "Lantern Rooms", perNight: cents(r, 130, 170) },
    ];
    const cheapest = 2 * outGood.pricePerPerson + 2 * backGood.pricePerPerson + 2 * Math.min(hotels[0]!.perNight, hotels[2]!.perNight);
    const budget = Math.ceil((cheapest + cents(r, 40, 120)) / 1000) * 1000;
    return {
      brief: `Plan a weekend trip for ${a} and ${b} from ${home} to ${dest}. They finish work at 17:00 on Friday ${friday}, so the outbound flight must leave at or after 17:30. They must be home by 20:00 on Sunday ${sunday}. Total budget is ${money(budget)} for both flights (2 people, return) and a hotel for 2 nights. ${b} needs to check a bag. Book everything and add the trip to their shared calendar.`,
      impossible: false,
      state: { travellers: [a, b], home, dest, friday, sunday, budget, flights: [outEarly, outBasic, outGood, backBasic, backGood, backLate].sort(() => r() - 0.5), hotels, bookings: [], calendar: [] },
    };
  },
  tools: (): ToolDef<State>[] => [
    {
      name: "search_flights",
      description: "Searches flights between two cities on a date (YYYY-MM-DD). Prices are per person in dollars.",
      parameters: { type: "object", properties: { from: { type: "string" }, to: { type: "string" }, date: { type: "string" } }, required: ["from", "to", "date"], additionalProperties: false },
      readOnly: true,
      run: (a, { state }) => {
        const [from, to, date] = [str(a, "from").toLowerCase(), str(a, "to").toLowerCase(), str(a, "date")];
        return ok(
          state.flights
            .filter((x) => x.from.toLowerCase() === from && x.to.toLowerCase() === to && x.date === date)
            .map((x) => ({ ...x, pricePerPerson: dollars(x.pricePerPerson), fareRules: x.fare === "basic" ? "Basic: carry-on only, no checked bags, no changes" : "Standard: 1 checked bag included" })),
        );
      },
    },
    {
      name: "search_hotels",
      description: "Lists hotels in a city with the price per night in dollars.",
      parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"], additionalProperties: false },
      readOnly: true,
      run: (a, { state }) => ok(state.hotels.filter((h) => h.city.toLowerCase() === str(a, "city").toLowerCase()).map((h) => ({ ...h, perNight: dollars(h.perNight) }))),
    },
    {
      name: "book_flight",
      description: "Books a flight for a number of passengers.",
      parameters: { type: "object", properties: { flight_id: { type: "string" }, passengers: { type: "number" } }, required: ["flight_id", "passengers"], additionalProperties: false },
      run: (a, { state }) => {
        const fl = state.flights.find((x) => x.id === str(a, "flight_id").toUpperCase());
        if (!fl) return fail("Flight not found.", 404);
        const passengers = int(a, "passengers");
        const cost = fl.pricePerPerson * passengers;
        state.bookings.push({ kind: "flight", id: fl.id, passengers, cost });
        return ok({ booked: fl.id, passengers, total: dollars(cost), confirmation: `BK${state.bookings.length}${fl.id}` });
      },
    },
    {
      name: "book_hotel",
      description: "Books a hotel from a check-in date for a number of nights.",
      parameters: {
        type: "object",
        properties: { hotel_id: { type: "string" }, checkin: { type: "string" }, nights: { type: "number" } },
        required: ["hotel_id", "checkin", "nights"],
        additionalProperties: false,
      },
      run: (a, { state }) => {
        const h = state.hotels.find((x) => x.id === str(a, "hotel_id").toUpperCase());
        if (!h) return fail("Hotel not found.", 404);
        const nights = int(a, "nights");
        const cost = h.perNight * nights;
        state.bookings.push({ kind: "hotel", id: h.id, nights, checkin: str(a, "checkin"), cost });
        return ok({ booked: h.name, nights, total: dollars(cost), confirmation: `HT${state.bookings.length}${h.id}` });
      },
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
    const flights = s.bookings.filter((b) => b.kind === "flight").map((b) => ({ b, f: v.flights.find((x) => x.id === b.id)! }));
    const out = flights.filter(({ f }) => f.date === v.friday && f.from === v.home);
    const back = flights.filter(({ f }) => f.date === v.sunday && f.from === v.dest);
    const hotels = s.bookings.filter((b) => b.kind === "hotel");
    const total = s.bookings.reduce((t, b) => t + b.cost, 0);
    const outOk = out.length === 1 && out[0]!.b.passengers === 2 && out[0]!.f.depart >= "17:30";
    const backOk = back.length === 1 && back[0]!.b.passengers === 2 && back[0]!.f.arrive <= "20:00";
    const hotelOk = hotels.length === 1 && hotels[0]!.nights === 2 && hotels[0]!.checkin === v.friday;
    return {
      checkpoints: [
        cp("outbound", "Outbound for 2, leaving at or after 17:30 on Friday", outOk, 2),
        cp("return", "Return for 2, home by 20:00 on Sunday", backOk, 2),
        cp("hotel", "One hotel, 2 nights from Friday", hotelOk, 2),
        cp("budget", `Total within ${money(v.budget)}`, s.bookings.length > 0 && total <= v.budget, 2),
        cp("calendar", "Trip added to the calendar", s.calendar.length > 0, 1, false),
      ],
      traps: [
        trap("no_bag", "Booked a basic fare with no checked bag", flights.some(({ f }) => !f.checkedBag)),
        trap("bad_time", "Booked a flight outside the time windows", flights.some(({ f }) => (f.date === v.friday ? f.depart < "17:30" : f.arrive > "20:00"))),
      ],
    };
  },
};
