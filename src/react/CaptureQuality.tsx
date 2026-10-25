import { Menu } from "@base-ui/react/menu";
import { Popover } from "@base-ui/react/popover";
import { ChevronRight, SlidersHorizontal } from "lucide-react";
import { captureResolutions, defaultCapture } from "../viewer/capture";
import { viewerScope } from "./context";
import { useViewerElements } from "./runtime";

export function CaptureQuality() {
  const { browserMenu: container } = useViewerElements();
  const model = viewerScope.useModel();
  const capture = viewerScope.useValue(model.capture$);
  const canChange = viewerScope.useValue(model.canChangeCapture$);
  const choose = viewerScope.useCommand(model.chooseCapture$);
  const identity = viewerScope.useIdentity();
  const automatic =
    capture.maxWidth === undefined && capture.maxHeight === undefined;
  const preset = captureResolutions.find(
    ({ width, height }) =>
      width === capture.maxWidth && height === capture.maxHeight,
  );
  const resolution = automatic
    ? "automatic"
    : preset
      ? `${preset.width}x${preset.height}`
      : "custom";
  return (
    <Popover.Root>
      <Popover.Trigger
        nativeButton={false}
        role="menuitem"
        render={<Menu.Item closeOnClick={false} />}
        className="cdpv-browser-menu-item"
      >
        <SlidersHorizontal size={16} aria-hidden="true" />
        Capture quality
        <ChevronRight
          className="cdpv-browser-menu-chevron"
          size={16}
          aria-hidden="true"
        />
      </Popover.Trigger>
      <Popover.Portal
        container={container}
        className="cdpv-browser-menu-container"
      >
        <Popover.Positioner
          className="cdpv-browser-menu-positioner"
          side="left"
          align="start"
          sideOffset={6}
          alignOffset={-5}
          collisionPadding={8}
          collisionAvoidance={{
            side: "shift",
            align: "shift",
            fallbackAxisSide: "none",
          }}
        >
          <Popover.Popup
            className="cdpv-browser-menu cdpv-capture-quality"
            onKeyDown={(event) => {
              // Native fields own navigation; Escape still dismisses the popup.
              if (event.key !== "Escape") event.stopPropagation();
            }}
          >
            <Popover.Title className="cdpv-capture-quality-title">
              Capture quality
            </Popover.Title>
            <fieldset
              disabled={!canChange}
              className="cdpv-capture-quality-fields"
            >
              <div className="cdpv-capture-quality-field">
                <label htmlFor={`${identity}-quality`}>
                  JPEG quality
                  <output htmlFor={`${identity}-quality`}>
                    {capture.quality ?? defaultCapture.quality}
                  </output>
                </label>
                <input
                  id={`${identity}-quality`}
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={capture.quality ?? defaultCapture.quality}
                  onChange={(event) =>
                    choose({ ...capture, quality: Number(event.target.value) })
                  }
                />
              </div>
              <div className="cdpv-capture-quality-field">
                <label htmlFor={`${identity}-resolution`}>
                  Capture resolution <span>maximum</span>
                </label>
                <select
                  id={`${identity}-resolution`}
                  value={resolution}
                  onChange={(event) => {
                    if (event.target.value === "automatic") {
                      choose(
                        capture.quality === undefined
                          ? {}
                          : { quality: capture.quality },
                      );
                      return;
                    }
                    const selected = captureResolutions.find(
                      ({ width, height }) =>
                        `${width}x${height}` === event.target.value,
                    );
                    if (selected)
                      choose({
                        ...capture,
                        maxWidth: selected.width,
                        maxHeight: selected.height,
                      });
                  }}
                >
                  <option value="automatic">
                    Automatic (container and DPR)
                  </option>
                  {resolution === "custom" && (
                    <option value="custom" disabled>
                      Custom ({capture.maxWidth ?? "auto"} ×{" "}
                      {capture.maxHeight ?? "auto"})
                    </option>
                  )}
                  {captureResolutions.map(({ width, height }) => (
                    <option key={width} value={`${width}x${height}`}>
                      {width} × {height}
                    </option>
                  ))}
                </select>
              </div>
            </fieldset>
            <Popover.Description className="cdpv-capture-quality-hint">
              Changes apply live without resizing the remote page.
              {!canChange && " These settings are managed by this application."}
            </Popover.Description>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
