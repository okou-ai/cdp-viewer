// Adapted from okou-ai/okou@7354b16deac91ae677fa1edbfb82d16c5c6e5504.
/** Library policy: no-new-abort-controller. See docs/state-architecture.md. */
import { AST_NODE_TYPES } from "@typescript-eslint/utils";
import { createRule } from "../utils.js";
export default createRule({
  name: "no-new-abort-controller",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description:
        "Only explicit runtime primitive definitions may construct AbortController",
      recommended: true,
    },
    schema: [],
    messages: {
      noNewAbortController:
        "Inherit the existing operation lifetime. Only the named wire/controller/native-input definitions may construct AbortController; see docs/state-architecture.md.",
    },
  },
  create(context) {
    return {
      NewExpression(node) {
        if (
          node.callee.type === AST_NODE_TYPES.Identifier &&
          node.callee.name === "AbortController"
        ) {
          context.report({
            node,
            messageId: "noNewAbortController",
          });
        }
      },
    };
  },
});
