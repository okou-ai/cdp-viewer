import { createScope } from "../src/state/react";
import { createDemoModel } from "./model";

export const demoScope = createScope(createDemoModel);
