// Adapted from okou-ai/okou@7354b16deac91ae677fa1edbfb82d16c5c6e5504.
/** Library policy: no-void-statement. See docs/state-architecture.md. */
import { AST_NODE_TYPES } from "@typescript-eslint/utils";
import { createRule } from "../utils.js";
function isCallLike(node) {
  if (
    node.type === AST_NODE_TYPES.CallExpression ||
    node.type === AST_NODE_TYPES.NewExpression ||
    node.type === AST_NODE_TYPES.AwaitExpression ||
    node.type === AST_NODE_TYPES.MemberExpression
  ) {
    return true;
  }
  if (node.type === AST_NODE_TYPES.ChainExpression) {
    return isCallLike(node.expression);
  }
  return false;
}
export default createRule({
  name: "no-void-statement",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description: "Disallow discarded async work",
    },
    schema: [],
    messages: {
      noVoidStatement:
        "Do not discard async work with void. Await it or attach an explicit rejection handler that checks the captured lifetime before reporting failure.",
    },
  },
  create(context) {
    return {
      ExpressionStatement(node) {
        const expr = node.expression;
        if (
          expr.type !== AST_NODE_TYPES.UnaryExpression ||
          expr.operator !== "void"
        ) {
          return;
        }
        if (!isCallLike(expr.argument)) {
          return;
        }
        context.report({
          node: expr,
          messageId: "noVoidStatement",
        });
      },
    };
  },
});
