import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";

import { flatToPm, markdownToFlat, serializeEditorDoc } from "../composer-rich-text-doc";

/** Words Scribe may still revise, drawn faded at `at` (an expanded draft offset). */
export interface ComposerDictationPreview {
  readonly at: number;
  readonly text: string;
}

interface PreviewState {
  readonly preview: ComposerDictationPreview | null;
  readonly decorations: DecorationSet;
}

const DictationPreviewKey = new PluginKey<PreviewState>("composer-dictation-preview");

function previewDecorations(
  doc: ProseMirrorNode,
  preview: ComposerDictationPreview | null,
): DecorationSet {
  if (!preview || preview.text === "") return DecorationSet.empty;
  const map = serializeEditorDoc(doc);
  const pos = flatToPm(map, markdownToFlat(map, Math.min(preview.at, map.value.length)));
  const widget = document.createElement("span");
  widget.className = "composer-dictation-preview";
  widget.textContent = preview.text;
  widget.setAttribute("aria-hidden", "true");
  return DecorationSet.create(doc, [
    Decoration.widget(pos, widget, { side: 1, key: `dictation-${preview.text}` }),
  ]);
}

// The offset is kept rather than mapped: committed words reach the document a render after
// the preview moves past them, and recomputing from the offset lands it right once they do.
const DictationPreviewPlugin = new Plugin<PreviewState>({
  key: DictationPreviewKey,
  state: {
    init: () => ({ preview: null, decorations: DecorationSet.empty }),
    apply: (tr, previous, _, state) => {
      const meta = tr.getMeta(DictationPreviewKey) as
        | { readonly preview: ComposerDictationPreview | null }
        | undefined;
      if (meta)
        return { preview: meta.preview, decorations: previewDecorations(state.doc, meta.preview) };
      if (!tr.docChanged || previous.preview === null) return previous;
      return {
        preview: previous.preview,
        decorations: previewDecorations(state.doc, previous.preview),
      };
    },
  },
  props: {
    decorations: (state) => DictationPreviewKey.getState(state)?.decorations,
  },
});

export const ComposerDictationPreviewExtension = Extension.create({
  name: "composer-dictation-preview",
  addProseMirrorPlugins() {
    return [DictationPreviewPlugin];
  },
});

export function setComposerDictationPreview(
  view: EditorView,
  preview: ComposerDictationPreview | null,
): void {
  const current = DictationPreviewKey.getState(view.state)?.preview ?? null;
  if (current?.at === preview?.at && current?.text === preview?.text) return;
  view.dispatch(
    view.state.tr.setMeta(DictationPreviewKey, { preview }).setMeta("addToHistory", false),
  );
}
