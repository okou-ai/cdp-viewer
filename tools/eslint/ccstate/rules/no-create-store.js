// Adapted from okou-ai/okou@7354b16deac91ae677fa1edbfb82d16c5c6e5504.
import { AST_NODE_TYPES, ASTUtils } from "@typescript-eslint/utils";
import { createRule } from "../utils.js";
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
function isTypeQuery(node) {
  let parent = node.parent;
  while (parent?.type === AST_NODE_TYPES.TSQualifiedName) {
    parent = parent.parent;
  }
  return parent?.type === AST_NODE_TYPES.TSTypeQuery;
}
function privateInstanceStore(identifier, namespace) {
  const callee = namespace ? identifier.parent : identifier;
  const call = callee.parent;
  const field = call?.parent;
  return (
    call?.type === AST_NODE_TYPES.CallExpression &&
    call.callee === callee &&
    field?.type === AST_NODE_TYPES.PropertyDefinition &&
    field.value === call &&
    !field.static &&
    field.accessibility === "private" &&
    field.readonly
  );
}
export default createRule({
  name: "no-create-store",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description: "Keep each Store in a private readonly instance field",
      requiresTypeChecking: false,
    },
    schema: [],
    messages: {
      noCreateStore:
        "Create a Store only as a private readonly instance field; compose existing computed/commands everywhere else.",
    },
  },
  create(context) {
    return {
      ImportDeclaration(node) {
        if (node.source.value !== "ccstate" || node.importKind === "type") {
          return;
        }
        for (const specifier of node.specifiers) {
          const namespace =
            specifier.type === AST_NODE_TYPES.ImportNamespaceSpecifier;
          if (!namespace) {
            if (
              specifier.type !== AST_NODE_TYPES.ImportSpecifier ||
              specifier.importKind === "type"
            ) {
              continue;
            }
            const importedName =
              specifier.imported.type === AST_NODE_TYPES.Identifier
                ? specifier.imported.name
                : specifier.imported.value;
            if (importedName !== "createStore") {
              continue;
            }
          }
          for (const variable of context.sourceCode.getDeclaredVariables(
            specifier,
          )) {
            for (const reference of variable.references) {
              if (!reference.isValueReference || !reference.isRead()) {
                continue;
              }
              const identifier = reference.identifier;
              if (isTypeQuery(identifier)) {
                continue;
              }
              const parent = identifier.parent;
              if (
                namespace &&
                parent.type === AST_NODE_TYPES.MemberExpression &&
                parent.object === identifier
              ) {
                const name = memberName(parent);
                if (name !== null && name !== "createStore") {
                  continue;
                }
              }
              if (privateInstanceStore(identifier, namespace)) continue;
              context.report({ node: identifier, messageId: "noCreateStore" });
            }
          }
        }
      },
      ExportNamedDeclaration(node) {
        if (node.source?.value !== "ccstate" || node.exportKind === "type") {
          return;
        }
        for (const specifier of node.specifiers) {
          if (
            specifier.exportKind !== "type" &&
            (specifier.local.type === AST_NODE_TYPES.Identifier
              ? specifier.local.name
              : specifier.local.value) === "createStore"
          ) {
            context.report({ node: specifier, messageId: "noCreateStore" });
          }
        }
      },
      ExportAllDeclaration(node) {
        if (node.source.value === "ccstate" && node.exportKind !== "type") {
          context.report({ node, messageId: "noCreateStore" });
        }
      },
      ImportExpression(node) {
        if (
          node.source.type === AST_NODE_TYPES.Literal &&
          node.source.value === "ccstate"
        ) {
          context.report({ node, messageId: "noCreateStore" });
        }
      },
      CallExpression(node) {
        if (
          node.callee.type !== AST_NODE_TYPES.Identifier ||
          node.callee.name !== "require" ||
          node.arguments[0]?.type !== AST_NODE_TYPES.Literal ||
          node.arguments[0].value !== "ccstate"
        ) {
          return;
        }
        const variable = ASTUtils.findVariable(
          context.sourceCode.getScope(node),
          node.callee,
        );
        if (!variable || variable.defs.length === 0) {
          context.report({ node, messageId: "noCreateStore" });
        }
      },
    };
  },
});
