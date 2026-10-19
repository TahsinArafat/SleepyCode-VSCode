/**
 * Transcript payload projection for the webview.
 *
 * Every sync republishes the whole active conversation, so every field carried
 * on a transcript item is copied across the extension-host/webview boundary once
 * per sync. `fileSnapshot` holds the complete pre-edit contents of every file a
 * turn touched. It exists so a later edit or undo can restore those files, and
 * the renderer never reads it — so shipping it is per-sync overhead that grows
 * with both the conversation length and the size of the files it changed.
 * Drop it here; local state keeps the snapshots intact.
 *
 * Only `fileSnapshot` is removed. Every other field is either read by the
 * renderer or is cheap, and an unknown field that later becomes needed must
 * fail visibly in the UI rather than render as a silently missing control.
 */
export function webviewTranscriptItems<TItem extends { fileSnapshot?: readonly unknown[] }>(
  items: readonly TItem[] | undefined,
): readonly TItem[] | undefined {
  if (!items?.length) return items;
  // Most syncs carry no snapshot at all (anything that did not touch a file).
  // Returning the array untouched keeps those syncs allocation-free.
  if (!items.some(item => item?.fileSnapshot?.length)) return items;
  return items.map(item => {
    if (!item?.fileSnapshot?.length) return item;
    const { fileSnapshot: _snapshot, ...rest } = item;
    return rest as TItem;
  });
}