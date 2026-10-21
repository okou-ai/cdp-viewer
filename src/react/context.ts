import { createScope } from "../state/react";
import { createViewerModel } from "../viewer/model";

export const viewerScope = createScope(createViewerModel);
