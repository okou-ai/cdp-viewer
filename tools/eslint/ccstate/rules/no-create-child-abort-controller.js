// Adapted from okou-ai/okou@7354b16deac91ae677fa1edbfb82d16c5c6e5504.
/** Library policy: no-create-child-abort-controller. See docs/state-architecture.md. */
import { AST_NODE_TYPES, ASTUtils } from "@typescript-eslint/utils";
import { createRule } from "../utils.js";
const TARGET_NAME = "createChildAbortController";
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
  name: "no-create-child-abort-controller",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow createChildAbortController() — use the ccstate signal hierarchy",
      recommended: true,
      requiresTypeChecking: false,
    },
    schema: [],
    messages: {
      childAbortController:
        "Inherit the existing operation owner instead of creating an imperative child controller. See docs/state-architecture.md.",
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
          specifier.type !== AST_NODE_TYPES.ImportSpecifier)
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
      };
    }
    function isTargetCall(node) {
      const callee = node.callee;
      if (callee.type === AST_NODE_TYPES.Identifier) {
        const reference = importReference(callee);
        return reference
          ? reference.importedName === TARGET_NAME
          : callee.name === TARGET_NAME;
      }
      if (
        callee.type !== AST_NODE_TYPES.MemberExpression ||
        callee.object.type !== AST_NODE_TYPES.Identifier ||
        memberName(callee) !== TARGET_NAME
      ) {
        return false;
      }
      return importReference(callee.object)?.importedName === "*";
    }
    return {
      CallExpression(node) {
        if (isTargetCall(node)) {
          context.report({ node, messageId: "childAbortController" });
        }
      },
    };
  },
});
