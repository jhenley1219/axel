// Spec §2 — weight of a branch = openCount × depth of its longest open path.
type TreeNode = { dirId: string; parentSystemId?: string }

export function openChildrenOf(id: string, open: Array<TreeNode>): Array<TreeNode> {
  return open.filter(s => s.parentSystemId === id)
}

export function openDescendants(id: string, open: Array<TreeNode>): number {
  return 1 + openChildrenOf(id, open).reduce((sum, c) => sum + openDescendants(c.dirId, open), 0)
}

export function longestOpenPath(id: string, open: Array<TreeNode>): number {
  const depths = openChildrenOf(id, open).map(c => longestOpenPath(c.dirId, open))
  return 1 + (depths.length ? Math.max(...depths) : 0)
}

export function branchWeight(id: string, open: Array<TreeNode>): number {
  return openDescendants(id, open) * longestOpenPath(id, open)
}
