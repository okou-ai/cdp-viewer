import { Component, createContext, useContext } from "react";
import type { ReactNode, SyntheticEvent } from "react";
import type { CdpViewerProps } from "../viewer/types";
import { viewerScope } from "./context";
import { ViewerBinding } from "./binding";
import type { Elements, RuntimeState } from "./binding";

const ElementsContext = createContext<Elements | null>(null);

export function useViewerElements(): Elements {
  const elements = useContext(ElementsContext);
  if (!elements)
    throw new Error("Viewer elements require their runtime owner.");
  return elements;
}

/** Readiness belongs to the loaded image node, including a new overflow row. */
export function faviconImageLoaded(event: SyntheticEvent<HTMLImageElement>) {
  const image = event.currentTarget;
  if (image.naturalWidth > 0 && image.currentSrc === image.src)
    image.dataset.loaded = "";
}

/** Commit bridge only; application state and subscriptions stay in ccstate. */
class CommittedViewer extends Component<
  RuntimeState & { children: ReactNode }
> {
  private readonly binding = new ViewerBinding();

  componentDidMount() {
    this.binding.mount(this.props);
  }

  componentDidUpdate() {
    this.binding.update(this.props);
  }

  componentWillUnmount() {
    this.binding.close();
  }

  render() {
    return (
      <ElementsContext value={this.binding.elements}>
        {this.props.children}
      </ElementsContext>
    );
  }
}

export function ViewerRuntime(props: CdpViewerProps & { children: ReactNode }) {
  const model = viewerScope.useModel();
  const snapshot = viewerScope.useValue(model.snapshot$);
  const tabLayout = viewerScope.useValue(model.tabLayout$);
  const revision = viewerScope.useValue(model.revision$);
  const notification = viewerScope.useValue(model.notification$);
  const displayMode = viewerScope.useValue(model.windowSizeSync$);
  return (
    <CommittedViewer
      {...props}
      model={model}
      snapshot={snapshot}
      tabLayout={tabLayout}
      revision={revision}
      notification={notification}
      displayMode={displayMode}
    />
  );
}
