import { Menu } from "@base-ui/react/menu";
import { Check, ChevronRight, Network } from "lucide-react";
import { viewerScope } from "./context";
import { useViewerElements } from "./runtime";

export function TransportSettings() {
  const { browserMenu: container } = useViewerElements();
  const model = viewerScope.useModel();
  const transport = viewerScope.useValue(model.transport$);
  const canChange = viewerScope.useValue(model.canChangeTransport$);
  const canHover = viewerScope.useValue(model.browserMenuHover$);
  const choose = viewerScope.useCommand(model.chooseTransport$);
  return (
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
        <Network size={16} aria-hidden="true" />
        Transport
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
            aria-label="Transport"
          >
            <Menu.RadioGroup
              value={transport}
              onValueChange={(value) => {
                if (typeof value === "string") choose(value);
              }}
            >
              {(
                [
                  ["shared", "Shared (default)"],
                  ["split", "Split frame / control"],
                ] as const
              ).map(([value, label]) => (
                <Menu.RadioItem
                  key={value}
                  value={value}
                  closeOnClick
                  disabled={!canChange}
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
  );
}
