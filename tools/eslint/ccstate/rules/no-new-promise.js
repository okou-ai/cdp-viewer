// Adapted from okou-ai/okou@7354b16deac91ae677fa1edbfb82d16c5c6e5504.
/** Library policy: no-new-promise. See docs/state-architecture.md. */
import { AST_NODE_TYPES } from "@typescript-eslint/utils";
import { createRule } from "../utils.js";
import { inInstanceMember } from "../../ownership.js";
export default createRule({
  name: "no-new-promise",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description:
        "Deferred work requires a non-static instance resource owner",
      recommended: true,
    },
    schema: [],
    messages: {
      noNewPromise:
        "Construct deferred work only in a non-static instance resource member, outside render and commands.",
      noPromiseWithResolvers:
        "Construct deferred work only in a non-static instance resource member, outside render and commands.",
    },
  },
  create(context) {
    return {
      NewExpression(node) {
        if (
          node.callee.type === AST_NODE_TYPES.Identifier &&
          node.callee.name === "Promise" &&
          !inInstanceMember(node)
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
          node.callee.property.name === "withResolvers" &&
          !inInstanceMember(node)
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
