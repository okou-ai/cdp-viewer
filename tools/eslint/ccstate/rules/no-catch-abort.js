// Adapted from okou-ai/okou@7354b16deac91ae677fa1edbfb82d16c5c6e5504.
/** Signal graph commands propagate caught failures, including cancellation. */
import { AST_NODE_TYPES } from "@typescript-eslint/utils";
import { createRule } from "../utils.js";
function propagatesCaughtError(node) {
  const first = node.body.body[0];
  return (
    node.param?.type === AST_NODE_TYPES.Identifier &&
    first?.type === AST_NODE_TYPES.ThrowStatement &&
    first.argument.type === AST_NODE_TYPES.Identifier &&
    first.argument.name === node.param.name
  );
}
export default createRule({
  name: "no-catch-abort",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description: "Signal graph commands must propagate caught failures",
      recommended: true,
    },
    schema: [],
    messages: {
      noCatchAbort:
        "Let the command rejection propagate, or immediately rethrow the caught error. Recoverable transport errors belong to their runtime owner.",
    },
  },
  create(context) {
    return {
      CatchClause: (block) => {
        if (!propagatesCaughtError(block)) {
          context.report({
            node: block,
            messageId: "noCatchAbort",
          });
        }
      },
    };
  },
});
