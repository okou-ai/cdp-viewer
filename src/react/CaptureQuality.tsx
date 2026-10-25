import { Menu } from "@base-ui/react/menu";
import { Popover } from "@base-ui/react/popover";
import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import { Check, ChevronRight, SlidersHorizontal } from "lucide-react";
import { captureResolutions, defaultCapture } from "../viewer/capture";
import { viewerScope } from "./context";
import { useViewerElements } from "./runtime";

export function CaptureQuality() {
  const { browserMenu: container } = useViewerElements();
  const model = viewerScope.useModel();
  const capture = viewerScope.useValue(model.capture$);
  const canChange = viewerScope.useValue(model.canChangeCapture$);
  const open = viewerScope.useValue(model.captureMenuOpen$);
  const canHover = viewerScope.useValue(model.browserMenuHover$);
  const choose = viewerScope.useCommand(model.chooseCapture$);
  const setOpen = viewerScope.useCommand(model.setCaptureMenu$);
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
    <Popover.Root
      open={open}
      onOpenChange={(next, details) => {
        if (next && details.reason === "trigger-hover" && !open && !canHover) {
          details.cancel();
          return;
        }
        setOpen({ open: next, keyboard: details.reason === "escape-key" });
      }}
    >
      <Popover.Trigger
        openOnHover
        delay={100}
        nativeButton={false}
        role="menuitem"
        render={<Menu.Item closeOnClick={false} />}
        className="cdpv-browser-menu-item"
        onMouseEnter={(event) => {
          if (!canHover && !open) event.preventBaseUIHandler();
        }}
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
                <label
                  htmlFor={`${identity}-quality`}
                  className="cdpv-capture-quality-label"
                >
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
                  onKeyDown={(event) => {
                    // Enter on a range must not submit an enclosing host form.
                    if (event.key === "Enter") event.preventDefault();
                  }}
                  onChange={(event) =>
                    choose({ ...capture, quality: Number(event.target.value) })
                  }
                />
              </div>
              <div className="cdpv-capture-quality-field">
                <span
                  id={`${identity}-resolution`}
                  className="cdpv-capture-quality-label"
                >
                  Capture resolution <span>maximum</span>
                </span>
                <RadioGroup
                  aria-labelledby={`${identity}-resolution`}
                  className="cdpv-capture-resolutions"
                  value={resolution}
                  disabled={!canChange}
                  onValueChange={(value) => {
                    if (value === "automatic") {
                      choose(
                        capture.quality === undefined
                          ? {}
                          : { quality: capture.quality },
                      );
                      return;
                    }
                    const selected = captureResolutions.find(
                      ({ width, height }) => `${width}x${height}` === value,
                    );
                    if (selected)
                      choose({
                        ...capture,
                        maxWidth: selected.width,
                        maxHeight: selected.height,
                      });
                  }}
                >
                  {[
                    { value: "automatic", label: "Auto" },
                    ...captureResolutions.map(({ width, height }) => ({
                      value: `${width}x${height}`,
                      label: `${width} × ${height}`,
                    })),
                  ].map(({ value, label }) => (
                    <Radio.Root
                      key={value}
                      value={value}
                      nativeButton
                      render={<button type="button" />}
                      className="cdpv-browser-menu-item cdpv-capture-resolution-option"
                    >
                      <span
                        className="cdpv-browser-menu-check"
                        aria-hidden="true"
                      >
                        <Radio.Indicator>
                          <Check size={16} />
                        </Radio.Indicator>
                      </span>
                      {label}
                    </Radio.Root>
                  ))}
                </RadioGroup>
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
