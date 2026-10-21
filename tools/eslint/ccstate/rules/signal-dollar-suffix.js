// Adapted from okou-ai/okou@7354b16deac91ae677fa1edbfb82d16c5c6e5504.
/**
 * ESLint rule: signal-dollar-suffix
 *
 * Enforces that variables assigned from state(), computed(), or command()
 * calls must end with a $ suffix.
 *
 * Good: const count$ = state(0)
 * Bad: const count = state(0)
 */
import { createRule } from "../utils.js";
const SIGNAL_FUNCTIONS = new Set(["state", "computed", "command"]);
export default createRule({
  name: "signal-dollar-suffix",
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Enforce $ suffix for variables assigned from state(), computed(), or command()",
    },
    schema: [],
    messages: {
      missingSuffix:
        "Variable '{{name}}' should end with '$' suffix because it holds a {{functionName}}() result",
    },
  },
  defaultOptions: [],
  create(context) {
    function isSignalCall(node) {
      if (node.type !== "CallExpression") {
        return { isSignal: false, functionName: "" };
      }
      const callee = node.callee;
      if (callee.type === "Identifier" && SIGNAL_FUNCTIONS.has(callee.name)) {
        return { isSignal: true, functionName: callee.name };
      }
      return { isSignal: false, functionName: "" };
    }
    function checkVariableDeclarator(node) {
      if (!node.init) {
        return;
      }
      const { isSignal, functionName } = isSignalCall(node.init);
      if (!isSignal) {
        return;
      }
      if (node.id.type !== "Identifier") {
        return;
      }
      const variableName = node.id.name;
      if (!variableName.endsWith("$")) {
        context.report({
          node: node.id,
          messageId: "missingSuffix",
          data: {
            name: variableName,
            functionName,
          },
        });
      }
    }
    return {
      VariableDeclarator: checkVariableDeclarator,
    };
  },
});
