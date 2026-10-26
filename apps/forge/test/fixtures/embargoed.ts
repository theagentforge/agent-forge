import { EMBARGOED_MODEL_IDS, modelById } from "../../src/arena/lineup";

// The embargoed model the embargo tests seed (ADR 0041), read from the lineup rather than named here, so these tests
// can go to the public mirror: there the lineup holds a stand-in (public-repo/lineup-embargoed.ts) and no real name.
const id = EMBARGOED_MODEL_IDS[0];
if (!id) throw new Error("No embargoed model in the lineup: the embargo tests need one (the public copy ships a stand-in)");
const model = modelById(id)!;

export const EMBARGOED = { id: model.id, name: model.name };
/** Matches the embargoed model's id or name anywhere in a page, JSON or feed. */
export const SHOWS_EMBARGOED = new RegExp(`${model.id}|${model.name}`, "i");
