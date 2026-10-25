import { Menu } from "@base-ui/react/menu";
import {
  Check,
  ChevronRight,
  EllipsisVertical,
  LoaderCircle,
  Maximize,
  Scaling,
} from "lucide-react";
import { viewerScope } from "./context";
import { useViewerElements } from "./runtime";
import { CaptureQuality } from "./CaptureQuality";
import { TransportSettings } from "./TransportSettings";

export function BrowserMenu() {
  const { browserMenu: container } = useViewerElements();
  const model = viewerScope.useModel();
  const mode = viewerScope.useValue(model.windowSizeSync$);
  const display = viewerScope.useValue(model.display$);
  const controls = viewerScope.useValue(model.controls$);
  const canHover = viewerScope.useValue(model.browserMenuHover$);
  const chooseMode = viewerScope.useCommand(model.chooseWindowSizeSync$);
  const sync = viewerScope.useCommand(model.syncDisplay$);
  const point = viewerScope.useCommand(model.pointBrowserMenu$);
  const reset = viewerScope.useCommand(model.resetBrowserMenu$);
  return (
    <Menu.Root modal={false} onOpenChange={() => reset()}>
      <Menu.Trigger
        type="button"
        className="cdpv-button cdpv-browser-menu-trigger"
        aria-label="Browser menu"
        title={
          display.pointerBlocked && !display.pending
            ? "Browser menu — display recovery required"
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
          <Menu.Popup
            className="cdpv-browser-menu"
            aria-label="Browser menu"
            onPointerMove={() => point()}
          >
            <TransportSettings />
            <CaptureQuality />
            <Menu.SubmenuRoot
              onOpenChange={(open, details) => {
                if (open && details.reason === "trigger-hover" && !canHover)
                  details.cancel();
              }}
            >
              <Menu.SubmenuTrigger
                className="cdpv-browser-menu-item"
                onMouseEnter={(event) => {
                  if (!canHover) event.preventBaseUIHandler();
                }}
              >
                <Scaling size={16} aria-hidden="true" />
                Fit to this viewer
                <ChevronRight
                  className="cdpv-browser-menu-chevron"
                  size={16}
                  aria-hidden="true"
                />
              </Menu.SubmenuTrigger>
              <Menu.Portal
                container={container}
                className="cdpv-browser-menu-container"
              >
                <Menu.Positioner
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
                  <Menu.Popup
                    className="cdpv-browser-menu cdpv-browser-submenu"
                    aria-label="Fit to this viewer"
                  >
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
                  </Menu.Popup>
                </Menu.Positioner>
              </Menu.Portal>
            </Menu.SubmenuRoot>
            <Menu.Item
              className="cdpv-browser-menu-item"
              disabled={!controls.canSyncDisplay}
              onClick={() => sync()}
            >
              <Maximize size={16} aria-hidden="true" />
              {display.pending ? "Syncing…" : "Sync now"}
            </Menu.Item>
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
