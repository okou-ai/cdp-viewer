import { Menu } from "@base-ui/react/menu";
import { Check, EllipsisVertical, LoaderCircle, Maximize } from "lucide-react";
import { viewerScope } from "./context";
import { useViewerElements } from "./runtime";

export function BrowserMenu() {
  const { browserMenu: container } = useViewerElements();
  const model = viewerScope.useModel();
  const mode = viewerScope.useValue(model.windowSizeSync$);
  const display = viewerScope.useValue(model.display$);
  const controls = viewerScope.useValue(model.controls$);
  const chooseMode = viewerScope.useCommand(model.chooseWindowSizeSync$);
  const sync = viewerScope.useCommand(model.syncDisplay$);
  return (
    <Menu.Root modal={false}>
      <Menu.Trigger
        type="button"
        className="cdpv-button cdpv-browser-menu-trigger"
        aria-label="Browser menu"
        title={
          display.pointerBlocked && !display.pending
            ? "Browser menu — display recovery required"
            : display.constrained
              ? "Browser menu — size limit reached"
              : "Browser menu"
        }
      >
        {display.pending ? (
          <LoaderCircle
            className="cdpv-spinning"
            size={16}
            aria-hidden="true"
          />
        ) : (
          <EllipsisVertical size={16} aria-hidden="true" />
        )}
      </Menu.Trigger>
      <div ref={container} className="cdpv-browser-menu-container" />
      <Menu.Portal
        container={container}
        className="cdpv-browser-menu-container"
      >
        <Menu.Positioner
          className="cdpv-browser-menu-positioner"
          align="end"
          sideOffset={6}
          collisionPadding={8}
        >
          <Menu.Popup className="cdpv-browser-menu">
            <Menu.Group>
              <Menu.GroupLabel className="cdpv-browser-menu-heading">
                Fit to this viewer
              </Menu.GroupLabel>
              <Menu.RadioGroup
                value={mode}
                onValueChange={(value) => {
                  if (typeof value === "string") chooseMode(value);
                }}
              >
                {(
                  [
                    ["off", "Do not sync automatically"],
                    ["initial", "Sync once on opening"],
                    ["live", "Sync continuously"],
                  ] as const
                ).map(([value, label]) => (
                  <Menu.RadioItem
                    key={value}
                    value={value}
                    closeOnClick
                    disabled={!controls.canChangeSyncMode}
                    className="cdpv-browser-menu-item"
                  >
                    <span className="cdpv-browser-menu-check">
                      <Menu.RadioItemIndicator>
                        <Check size={16} aria-hidden="true" />
                      </Menu.RadioItemIndicator>
                    </span>
                    {label}
                  </Menu.RadioItem>
                ))}
              </Menu.RadioGroup>
            </Menu.Group>
            <Menu.Separator className="cdpv-browser-menu-separator" />
            <Menu.Item
              className="cdpv-browser-menu-item"
              disabled={!controls.canSyncDisplay}
              onClick={() => sync()}
            >
              <Maximize size={16} aria-hidden="true" />
              {display.pending ? "Syncing…" : "Sync now"}
            </Menu.Item>
            {display.constrained && (
              <div className="cdpv-browser-menu-heading" role="status">
                Size limit reached
              </div>
            )}
            {display.pointerBlocked && !display.pending && (
              <div className="cdpv-browser-menu-heading" role="status">
                Use Sync now to resume pointer input
              </div>
            )}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
