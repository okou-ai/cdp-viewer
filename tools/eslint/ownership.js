/** Syntax-based ownership is identical in every source file. */
export function inCommand(node) {
  for (let parent = node.parent; parent; parent = parent.parent)
    if (
      parent.type === "CallExpression" &&
      parent.callee.type === "Identifier" &&
      parent.callee.name === "command"
    )
      return true;
  return false;
}

export function inInstanceMember(node) {
  if (inCommand(node)) return false;
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (["MethodDefinition", "PropertyDefinition"].includes(parent.type))
      return !parent.static && parent.key.name !== "render";
    if (["StaticBlock", "ClassBody"].includes(parent.type)) return false;
  }
  return false;
}

export function owningFactory(node) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (
      [
        "FunctionDeclaration",
        "FunctionExpression",
        "ArrowFunctionExpression",
      ].includes(parent.type)
    )
      return (
        parent.id?.name ??
        (parent.parent.type === "VariableDeclarator"
          ? parent.parent.id.name
          : "")
      );
  }
  return "";
}

export function inView(node) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (["MethodDefinition", "PropertyDefinition"].includes(parent.type))
      return parent.key.name === "render";
    if (
      [
        "FunctionDeclaration",
        "FunctionExpression",
        "ArrowFunctionExpression",
      ].includes(parent.type)
    ) {
      const name =
        parent.id?.name ??
        (parent.parent.type === "VariableDeclarator"
          ? parent.parent.id.name
          : "");
      if (/^(?:[A-Z]|use[A-Z])/.test(name ?? "")) return true;
      if (parent.parent.type === "ExportDefaultDeclaration") return true;
    }
  }
  return false;
}
