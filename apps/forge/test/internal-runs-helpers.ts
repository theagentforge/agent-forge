import { PRACTICE_ONLY_TASK_IDS } from "@forge/arena";
import { EMBARGOED_MODEL_IDS } from "../src/arena/lineup";

/** Fills the two private-list placeholders of the stats rules' SQL (rules 2.5) with the real lists, for tests only. */
export const fillPrivateLists = (q: string) =>
  q
    .replaceAll("<EMBARGOED_MODEL_IDS>", EMBARGOED_MODEL_IDS.map((id) => `'${id}'`).join(", "))
    .replaceAll("<PRIVATE_TASK_IDS>", PRACTICE_ONLY_TASK_IDS.map((id) => `'${id}'`).join(", "));
