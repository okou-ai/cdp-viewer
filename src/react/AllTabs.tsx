import { Select } from "@base-ui/react/select";
import { Check, ChevronDown, Globe } from "lucide-react";
import { viewerScope } from "./context";

/** The popup stays in the viewer tree to inherit its theme and clipping bounds. */
export function AllTabs() {
  const model = viewerScope.useModel();
  const snapshot = viewerScope.useValue(model.snapshot$);
  const controls = viewerScope.useValue(model.controls$);
  const select = viewerScope.useCommand(model.select$);

  return (
    <div className="cdpv-tab-picker">
      <Select.Root
        value={snapshot.selectedTargetId}
        disabled={controls.tabsDisabled}
        modal={false}
        onValueChange={(value) => {
          if (typeof value === "string") select(value);
        }}
      >
        <Select.Trigger
          type="button"
          className="cdpv-button cdpv-tab-picker-trigger"
          aria-label="All tabs"
          title="All tabs"
        >
          <ChevronDown size={16} aria-hidden="true" />
        </Select.Trigger>
        <Select.Positioner
          className="cdpv-tab-positioner"
          align="end"
          sideOffset={6}
          collisionPadding={8}
          alignItemWithTrigger={false}
        >
          <Select.Popup className="cdpv-tab-popup">
            <div className="cdpv-tab-popup-heading" aria-hidden="true">
              All tabs
            </div>
            <Select.List className="cdpv-tab-options" aria-label="All tabs">
              {snapshot.targets.map((target) => (
                <Select.Item
                  key={target.id}
                  value={target.id}
                  label={target.title}
                  title={target.title}
                  data-tab-option={target.id}
                  className="cdpv-tab-option"
                >
                  <Globe size={16} aria-hidden="true" />
                  <Select.ItemText className="cdpv-tab-option-title">
                    {target.title}
                  </Select.ItemText>
                  <Select.ItemIndicator className="cdpv-tab-option-check">
                    <Check size={16} aria-hidden="true" />
                  </Select.ItemIndicator>
                </Select.Item>
              ))}
            </Select.List>
          </Select.Popup>
        </Select.Positioner>
      </Select.Root>
    </div>
  );
}
