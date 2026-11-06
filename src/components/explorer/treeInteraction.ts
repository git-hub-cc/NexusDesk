import type { MouseEvent } from "react";
import type { NodeApi } from "react-arborist";

/** Select without Arborist's default single-click activation. */
export function selectTreeNode(event: MouseEvent, node: NodeApi<any>) {
  event.stopPropagation();
  if ((event.metaKey || event.ctrlKey) && !node.tree.props.disableMultiSelection) {
    if (node.isSelected) node.deselect();
    else node.selectMulti();
  } else if (event.shiftKey && !node.tree.props.disableMultiSelection) {
    node.selectContiguous();
  } else {
    node.select();
    if (!node.isLeaf && !node.data.missing) node.toggle();
  }
}

export function activateTreeFile(event: MouseEvent, node: NodeApi<any>) {
  event.stopPropagation();
  if (node.isLeaf && !node.data.missing) node.activate();
}
