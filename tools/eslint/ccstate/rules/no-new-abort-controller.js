// Adapted from okou-ai/okou@7354b16deac91ae677fa1edbfb82d16c5c6e5504.
/** Library policy: no-new-abort-controller. See docs/state-architecture.md. */
import { AST_NODE_TYPES } from "@typescript-eslint/utils";
import { createRule } from "../utils.js";
import { inInstanceMember } from "../../ownership.js";
export default createRule({
  name: "no-new-abort-controller",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description:
        "Cancellation construction requires an instance resource owner",
      recommended: true,
    },
    schema: [],
    messages: {
      noNewAbortController:
        "Inherit command cancellation; construct a new lifetime only in a non-static instance resource member.",
    },
  },
  create(context) {
    return {
      NewExpression(node) {
        if (
          node.callee.type === AST_NODE_TYPES.Identifier &&
          node.callee.name === "AbortController" &&
          !inInstanceMember(node)
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
