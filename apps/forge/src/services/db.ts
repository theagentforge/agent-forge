import { drizzle } from "drizzle-orm/d1";
import * as schema from "../db/schema";

export const getDb = (env: Env) => drizzle(env.DB, { schema });
export type Db = ReturnType<typeof getDb>;

export const newId = () => crypto.randomUUID();
