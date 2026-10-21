// Adapted from okou-ai/okou@7354b16deac91ae677fa1edbfb82d16c5c6e5504.
/**
 * ESLint rule: no-command-in-command
 *
 * A ccstate command is part of the static signal graph. Creating one while
 * another command is running only allocates a fresh command identity around a
 * JavaScript closure; it does not add state, memoization, or lifecycle.
 */
import { AST_NODE_TYPES, ASTUtils } from "@typescript-eslint/utils";
import { createRule } from "../utils.js";
function isCallbackNode(node) {
  return (
    node.type === AST_NODE_TYPES.ArrowFunctionExpression ||
    node.type === AST_NODE_TYPES.FunctionExpression
  );
}
function memberName(node) {
  if (!node.computed && node.property.type === AST_NODE_TYPES.Identifier) {
    return node.property.name;
  }
  if (
    node.computed &&
    node.property.type === AST_NODE_TYPES.Literal &&
    typeof node.property.value === "string"
  ) {
    return node.property.value;
  }
  return null;
}
export default createRule({
  name: "no-command-in-command",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow creating a ccstate command while another command is running",
      recommended: true,
      requiresTypeChecking: false,
    },
    schema: [],
    messages: {
      nestedCommand:
        "Do not create command() inside another command(). Define a stable command outside the callback and pass runtime values as command arguments or ccstate state.",
    },
  },
  create(context) {
    function importReference(node) {
      const variable = ASTUtils.findVariable(
        context.sourceCode.getScope(node),
        node,
      );
      const definition = variable?.defs.find((candidate) => {
        return candidate.type === "ImportBinding";
      });
      const specifier = definition?.node;
      if (
        specifier === undefined ||
        (specifier.type !== AST_NODE_TYPES.ImportNamespaceSpecifier &&
          specifier.type !== AST_NODE_TYPES.ImportSpecifier) ||
        specifier.parent.type !== AST_NODE_TYPES.ImportDeclaration ||
        typeof specifier.parent.source.value !== "string"
      ) {
        return null;
      }
      return {
        importedName:
          specifier.type === AST_NODE_TYPES.ImportNamespaceSpecifier
            ? "*"
            : specifier.imported.type === AST_NODE_TYPES.Identifier
              ? specifier.imported.name
              : String(specifier.imported.value),
        source: specifier.parent.source.value,
      };
    }
    function isCommandCall(node) {
      const callee = node.callee;
      if (callee.type === AST_NODE_TYPES.Identifier) {
        const reference = importReference(callee);
        return (
          reference?.source === "ccstate" &&
          reference.importedName === "command"
        );
      }
      if (
        callee.type !== AST_NODE_TYPES.MemberExpression ||
        callee.object.type !== AST_NODE_TYPES.Identifier ||
        memberName(callee) !== "command"
      ) {
        return false;
      }
      const reference = importReference(callee.object);
      return reference?.source === "ccstate" && reference.importedName === "*";
    }
    function isInsideCommandCallback(node) {
      let current = node.parent;
      while (current) {
        if (isCallbackNode(current)) {
          const parent = current.parent;
          if (
            parent.type === AST_NODE_TYPES.CallExpression &&
            parent.arguments[0] === current &&
            isCommandCall(parent)
          ) {
            return true;
          }
        }
        current = current.parent;
      }
      return false;
    }
    return {
      CallExpression(node) {
        if (!isCommandCall(node) || !isInsideCommandCallback(node)) {
          return;
        }
        context.report({ node, messageId: "nestedCommand" });
      },
    };
  },
});
