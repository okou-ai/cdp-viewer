import { viewerScope } from "./context";
import { useViewerElements } from "./runtime";

/** Only this owned subtree admits remote gestures and captures their release. */
export function RemoteSurface({ interactive }: { interactive: boolean }) {
  const model = viewerScope.useModel();
  const controls = viewerScope.useValue(model.controls$);
  const { surface, canvas, proxy } = useViewerElements();
  const selectId = viewerScope.useIdentity();
  return (
    <div
      ref={surface}
      className={`cdpv-remote-surface${interactive ? " cdpv-interactive" : ""}`}
    >
      <canvas
        ref={canvas}
        role="img"
        aria-label="Live browser view"
        aria-hidden={!controls.streaming}
      >
        Your browser needs Canvas 2D to show the remote page.
      </canvas>
      {interactive && (
        <textarea
          ref={proxy}
          id={`${selectId}-input`}
          className="cdpv-input-proxy"
          aria-label="Remote browser input"
          disabled={!controls.streaming}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
          rows={1}
          wrap="off"
        />
      )}
    </div>
  );
}
