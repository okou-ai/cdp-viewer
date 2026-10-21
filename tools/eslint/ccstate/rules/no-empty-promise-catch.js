// Adapted from okou-ai/okou@7354b16deac91ae677fa1edbfb82d16c5c6e5504.
/** Library policy: no-empty-promise-catch. See docs/state-architecture.md. */
import { AST_NODE_TYPES } from "@typescript-eslint/utils";
import { createRule } from "../utils.js";
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
  name: "no-empty-promise-catch",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description: "Disallow empty promise catches",
    },
    schema: [],
    messages: {
      noEmptyPromiseCatch:
        "Do not hide promise failures in an empty catch. Await the operation or handle failure explicitly under its captured owner.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        // Match: expr.catch(() => {})
        if (
          node.callee.type !== AST_NODE_TYPES.MemberExpression ||
          node.callee.property.type !== AST_NODE_TYPES.Identifier ||
          node.callee.property.name !== "catch"
        ) {
          return;
        }
        // Must have exactly one argument that is an empty function
        if (
          node.arguments.length !== 1 ||
          !isEmptyFunction(node.arguments[0])
        ) {
          return;
        }
        context.report({
          node,
          messageId: "noEmptyPromiseCatch",
        });
      },
    };
  },
});
