import { Button } from "@base-ui/react/button";
import { Tabs } from "@base-ui/react/tabs";
import {
  ArrowLeft,
  ArrowRight,
  Plus,
  X,
  LoaderCircle,
  LucideProvider,
  RotateCw,
} from "lucide-react";
import type { ViewerLabels } from "../viewer/types";
import { AllTabs } from "./AllTabs";
import { tabTitle } from "./labels";
import { Favicon } from "./Favicon";
import { BrowserMenu } from "./BrowserMenu";
import { viewerScope } from "./context";
import { useViewerElements } from "./runtime";

/** This subtree contains only viewer controls; host actions are frame siblings. */
export function ViewerToolbar({
  interactive,
  labels,
}: {
  interactive: boolean;
  labels: ViewerLabels | undefined;
}) {
  const model = viewerScope.useModel();
  const snapshot = viewerScope.useValue(model.snapshot$);
  const tabLayout = viewerScope.useValue(model.tabLayout$);
  const controls = viewerScope.useValue(model.controls$);
  const pending = viewerScope.useValue(model.tabAction$);
  const createTab = viewerScope.useCommand(model.createTab$);
  const closeTab = viewerScope.useCommand(model.closeTab$);
  const { toolbar, tabs } = useViewerElements();
  const selectId = viewerScope.useIdentity();
  return (
    <div ref={toolbar} className="cdpv-toolbar-controls">
      <LucideProvider>
        <Tabs.List
          id={selectId}
          ref={tabs}
          className="cdpv-tabs"
          aria-label="Browser tabs"
          activateOnFocus={false}
        >
          {tabLayout.items.map(({ target, width }) => {
            const title = tabTitle(target.title, labels);
            return (
              <div
                className="cdpv-tab-item"
                key={target.id}
                style={{ width }}
                data-selected={
                  target.id === snapshot.selectedTargetId ? "" : undefined
                }
              >
                <Tabs.Tab
                  type="button"
                  className="cdpv-tab"
                  value={target.id}
                  title={title}
                  aria-label={title}
                  disabled={controls.tabsDisabled}
                  data-target-id={target.id}
                >
                  <Favicon targetId={target.id} />
                  <span className="cdpv-tab-title">{title}</span>
                </Tabs.Tab>
                {interactive && (
                  <Button
                    type="button"
                    className="cdpv-close"
                    aria-label={`Close ${title}`}
                    title={`Close ${title}`}
                    data-close-target={target.id}
                    aria-busy={
                      pending?.type === "close" &&
                      pending.targetId === target.id
                    }
                    disabled={!controls.canMutateTabs}
                    onClick={() => closeTab(target.id)}
                  >
                    {pending?.type === "close" &&
                    pending.targetId === target.id ? (
                      <LoaderCircle
                        className="cdpv-spinning"
                        size={14}
                        aria-hidden="true"
                      />
                    ) : (
                      <X size={14} aria-hidden="true" />
                    )}
                  </Button>
                )}
              </div>
            );
          })}
        </Tabs.List>
        {tabLayout.overflow && <AllTabs labels={labels} />}
        {interactive && (
          <Button
            type="button"
            className="cdpv-button cdpv-new-tab"
            aria-label="New tab"
            aria-busy={pending?.type === "create"}
            title="New tab"
            disabled={!controls.canCreate}
            onClick={() => createTab()}
          >
            {pending?.type === "create" ? (
              <LoaderCircle
                className="cdpv-spinning"
                size={18}
                aria-hidden="true"
              />
            ) : (
              <Plus size={18} aria-hidden="true" />
            )}
          </Button>
        )}
      </LucideProvider>
    </div>
  );
}

export function NavigationToolbar({
  showSettingsMenu,
  placeholder,
}: {
  showSettingsMenu: boolean;
  placeholder: string;
}) {
  const model = viewerScope.useModel();
  const snapshot = viewerScope.useValue(model.snapshot$);
  const navigation = snapshot.navigation ?? null;
  const controls = viewerScope.useValue(model.controls$);
  const disabled = !controls.streaming;
  const { address: addressElement } = useViewerElements();
  const addressId = viewerScope.useIdentity() + "-address";
  const address = viewerScope.useValue(model.address$);
  const edit = viewerScope.useCommand(model.editAddress$);
  const focus = viewerScope.useCommand(model.focusAddress$);
  const blur = viewerScope.useCommand(model.blurAddress$);
  const submit = viewerScope.useCommand(model.submitAddress$);
  const navigate = viewerScope.useCommand(model.navigate$);
  return (
    <LucideProvider>
      <div className="cdpv-navigation">
        <Button
          className="cdpv-button"
          type="button"
          aria-label="Back remote page"
          disabled={disabled || !navigation?.canGoBack}
          onClick={() => navigate("back")}
        >
          <ArrowLeft size={16} aria-hidden="true" />
        </Button>
        <Button
          className="cdpv-button"
          type="button"
          aria-label="Forward remote page"
          disabled={disabled || !navigation?.canGoForward}
          onClick={() => navigate("forward")}
        >
          <ArrowRight size={16} aria-hidden="true" />
        </Button>
        <Button
          className="cdpv-button"
          type="button"
          aria-label="Reload remote page"
          disabled={disabled}
          onClick={() => navigate("reload")}
        >
          <RotateCw size={16} aria-hidden="true" />
        </Button>
        <input
          ref={addressElement}
          id={addressId}
          type="text"
          className="cdpv-address"
          aria-label="Remote page address"
          placeholder={placeholder}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          value={address}
          onChange={(event) => edit(event.target.value)}
          onFocus={() => focus()}
          onBlur={() => blur()}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.stopPropagation();
            if (
              event.nativeEvent.isComposing ||
              event.nativeEvent.keyCode === 229
            )
              return;
            event.preventDefault();
            submit();
          }}
        />
        {showSettingsMenu && <BrowserMenu />}
      </div>
    </LucideProvider>
  );
}
