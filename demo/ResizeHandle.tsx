import { MoveDiagonal } from "lucide-react";
import { demoScope } from "./context";
import type { Panel } from "./model";
import { viewerStyle } from "./playground";
import {
  beginResize,
  finishResize,
  moveResize,
  releaseResize,
  resizeKey,
} from "./resize";

export function ResizeHandle({
  panel,
  identity,
}: {
  panel: Panel;
  identity: string;
}) {
  const model = demoScope.useModel();
  const begin = demoScope.useCommand(model.beginResize$);
  const move = demoScope.useCommand(model.moveResize$);
  const end = demoScope.useCommand(model.endResize$);
  const nudge = demoScope.useCommand(model.nudgeResize$);
  const { id } = panel;
  return (
    <div className="demo-resize-frame" style={viewerStyle(panel.options)}>
      <button
        type="button"
        className="demo-resize-handle"
        aria-label={`Resize viewer ${id}`}
        aria-describedby={`${identity}-size ${identity}-resize-help`}
        title="Drag to resize. Arrow keys adjust size."
        data-resizing={panel.resize !== null}
        onPointerDown={(event) => beginResize(event, id, begin)}
        onPointerMove={(event) => moveResize(event, id, move, end)}
        onPointerUp={(event) => finishResize(event, id, move, end)}
        onPointerCancel={(event) =>
          releaseResize(event.currentTarget, id, end, event.pointerId)
        }
        onLostPointerCapture={(event) =>
          releaseResize(event.currentTarget, id, end, event.pointerId)
        }
        onBlur={(event) => releaseResize(event.currentTarget, id, end)}
        onKeyDown={(event) => resizeKey(event, id, nudge, end)}
      >
        <MoveDiagonal size={14} aria-hidden="true" />
      </button>
      <span id={`${identity}-resize-help`} className="demo-resize-help">
        Drag the corner to resize. Left and Right change width; Up and Down
        change height. Hold Shift for larger steps. Escape stops dragging.
      </span>
    </div>
  );
}
