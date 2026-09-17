import type { WalkedFile } from '../scan/walk.ts';
import type { FolderRole } from './roles.ts';

export interface FolderNode {
  /** Path relative to the root, forward-slashed; '' for the virtual root. */
  relPath: string;
  /** Basename; '' for the virtual root. */
  name: string;
  /** Files sitting directly in this folder, not in its descendants. */
  files: WalkedFile[];
  children: FolderNode[];
  role: FolderRole | null;
}

function byRelPath(a: FolderNode, b: FolderNode): number {
  return a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0;
}

/**
 * Rebuild the folder hierarchy from the flat inventory a scan produced.
 *
 * The root is a virtual node: it exists even when no folder row describes it,
 * because scanning a folder that *is* an album is normal, and its files have to
 * land somewhere. A file naming a folder that the walk never reported gets that
 * folder synthesised rather than dropped.
 */
export function buildTree(folders: readonly string[], files: readonly WalkedFile[]): FolderNode {
  const root: FolderNode = { relPath: '', name: '', files: [], children: [], role: null };
  const index = new Map<string, FolderNode>([['', root]]);

  const ensure = (relPath: string): FolderNode => {
    const known = index.get(relPath);
    if (known) return known;

    const cut = relPath.lastIndexOf('/');
    const parentRelPath = cut === -1 ? '' : relPath.slice(0, cut);
    const created: FolderNode = {
      relPath,
      name: relPath.slice(cut + 1),
      files: [],
      children: [],
      role: null,
    };

    ensure(parentRelPath).children.push(created);
    index.set(relPath, created);
    return created;
  };

  for (const folder of folders) ensure(folder);
  for (const file of files) ensure(file.folderRelPath).files.push(file);

  const sortDeep = (node: FolderNode): void => {
    node.children.sort(byRelPath);
    for (const child of node.children) sortDeep(child);
  };
  sortDeep(root);

  return root;
}
