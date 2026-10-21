// Adapted from okou-ai/okou@7354b16deac91ae677fa1edbfb82d16c5c6e5504.
/** Library policy: no-abort-swallower. See docs/state-architecture.md. */
import { AST_NODE_TYPES } from "@typescript-eslint/utils";
import { createRule } from "../utils.js";
const ABORT_SWALLOWERS = new Set(["throwIfNotAbort"]);
function isAbortSwallower(node) {
  return (
    node.type === AST_NODE_TYPES.Identifier && ABORT_SWALLOWERS.has(node.name)
  );
}
function isEmptyFunction(node) {
  if (
    node.type === AST_NODE_TYPES.ArrowFunctionExpression ||
    node.type === AST_NODE_TYPES.FunctionExpression
  ) {
    return (
      node.body.type === AST_NODE_TYPES.BlockStatement &&
      node.body.body.length === 0
    );
  }
  return false;
}
export default createRule({
  name: "no-abort-swallower",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow rejection handlers that silently swallow promise failures",
    },
    schema: [],
    messages: {
      noAbortSwallower:
        "Do not use {{handler}} to swallow cancellation. Propagate the rejection or handle it under the captured runtime owner.",
      noEmptyThenReject:
        "Do not hide promise failures in an empty then rejection handler. Await the operation or handle failure explicitly under its captured owner.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        if (
          node.callee.type !== AST_NODE_TYPES.MemberExpression ||
          node.callee.property.type !== AST_NODE_TYPES.Identifier
        ) {
          return;
        }
        const method = node.callee.property.name;
        if (method === "catch" && node.arguments.length === 1) {
          const handler = node.arguments[0];
          if (isAbortSwallower(handler)) {
            context.report({
              node,
              messageId: "noAbortSwallower",
              data: {
                handler:
                  handler.type === AST_NODE_TYPES.Identifier
                    ? handler.name
                    : "handler",
              },
            });
          }
          return;
        }
        if (method === "then" && node.arguments.length >= 2) {
          const rejectHandler = node.arguments[1];
          if (isAbortSwallower(rejectHandler)) {
            context.report({
              node,
              messageId: "noAbortSwallower",
              data: {
                handler:
                  rejectHandler.type === AST_NODE_TYPES.Identifier
                    ? rejectHandler.name
                    : "handler",
              },
            });
            return;
          }
          if (isEmptyFunction(rejectHandler)) {
            context.report({
              node,
              messageId: "noEmptyThenReject",
            });
          }
        }
      },
    };
  },
});
