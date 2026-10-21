import commandAsyncSignal from "./ccstate/rules/command-async-signal.js";
import computedConstArgs from "./ccstate/rules/computed-const-args-package-scope.js";
import noAbortSwallower from "./ccstate/rules/no-abort-swallower.js";
import noAccessorEscape from "./ccstate/rules/no-accessor-escape.js";
import noCatchAbort from "./ccstate/rules/no-catch-abort.js";
import noCommandInCommand from "./ccstate/rules/no-command-in-command.js";
import noComputedSignal from "./ccstate/rules/no-computed-signal.js";
import noCreateChild from "./ccstate/rules/no-create-child-abort-controller.js";
import noCreateStore from "./ccstate/rules/no-create-store.js";
import noEmptyCatch from "./ccstate/rules/no-empty-promise-catch.js";
import noExportState from "./ccstate/rules/no-export-state.js";
import noAccessorParams from "./ccstate/rules/no-getter-setter-params.js";
import noNewAbort from "./ccstate/rules/no-new-abort-controller.js";
import noNewPromise from "./ccstate/rules/no-new-promise.js";
import noPackageVariable from "./ccstate/rules/no-package-variable.js";
import noRenderEffect from "./ccstate/rules/no-side-effect-in-render.js";
import noStoreParams from "./ccstate/rules/no-store-in-params.js";
import noVoid from "./ccstate/rules/no-void-statement.js";
import signalCheckAwait from "./ccstate/rules/signal-check-await.js";
import signalDollarSuffix from "./ccstate/rules/signal-dollar-suffix.js";
import {
  instanceBoundaries,
  viewWrites,
  signalImports,
  privateState,
  noSuppression,
} from "./instance-boundaries.js";

export default {
  rules: {
    "command-async-signal": commandAsyncSignal,
    "computed-const-args-package-scope": computedConstArgs,
    "no-abort-swallower": noAbortSwallower,
    "no-accessor-escape": noAccessorEscape,
    "no-catch-abort": noCatchAbort,
    "no-command-in-command": noCommandInCommand,
    "no-computed-signal": noComputedSignal,
    "no-create-child-abort-controller": noCreateChild,
    "no-create-store": noCreateStore,
    "no-empty-promise-catch": noEmptyCatch,
    "no-export-state": noExportState,
    "no-getter-setter-params": noAccessorParams,
    "no-new-abort-controller": noNewAbort,
    "no-new-promise": noNewPromise,
    "no-package-variable": noPackageVariable,
    "no-side-effect-in-render": noRenderEffect,
    "no-store-in-params": noStoreParams,
    "no-void-statement": noVoid,
    "signal-check-await": signalCheckAwait,
    "signal-dollar-suffix": signalDollarSuffix,
    "instance-boundaries": instanceBoundaries,
    "view-writes": viewWrites,
    "signal-imports": signalImports,
    "private-state": privateState,
    "no-suppression": noSuppression,
  },
};
