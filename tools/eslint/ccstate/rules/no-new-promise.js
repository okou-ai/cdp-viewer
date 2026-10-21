// Adapted from okou-ai/okou@7354b16deac91ae677fa1edbfb82d16c5c6e5504.
/** Library policy: no-new-promise. See docs/state-architecture.md. */
import { AST_NODE_TYPES } from "@typescript-eslint/utils";
import { createRule } from "../utils.js";
export default createRule({
  name: "no-new-promise",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow `new Promise()` and `Promise.withResolvers()`. Use signal-aware helpers or existing abstractions instead.",
      recommended: true,
    },
    schema: [],
    messages: {
      noNewPromise:
        "Use an existing owner-bound operation. Only the CDP wire deferred definition may construct Promise.",
      noPromiseWithResolvers:
        "Use an existing owner-bound operation. Only the CDP wire deferred definition may construct a deferred promise.",
    },
  },
  create(context) {
    return {
      NewExpression(node) {
        if (
          node.callee.type === AST_NODE_TYPES.Identifier &&
          node.callee.name === "Promise"
        ) {
          context.report({
            node,
            messageId: "noNewPromise",
          });
        }
      },
      CallExpression(node) {
        if (
          node.callee.type === AST_NODE_TYPES.MemberExpression &&
          node.callee.object.type === AST_NODE_TYPES.Identifier &&
          node.callee.object.name === "Promise" &&
          node.callee.property.type === AST_NODE_TYPES.Identifier &&
          node.callee.property.name === "withResolvers"
        ) {
          context.report({
            node,
            messageId: "noPromiseWithResolvers",
          });
        }
      },
    };
  },
});
