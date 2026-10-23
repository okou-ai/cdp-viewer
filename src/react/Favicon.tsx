import { Globe } from "lucide-react";
import { viewerScope } from "./context";
import { faviconImageLoaded } from "./runtime";

export function Favicon({ targetId }: { targetId: string }) {
  const model = viewerScope.useModel();
  const icons = viewerScope.useValue(model.favicons$);
  const icon = icons.get(targetId);
  const rejectFavicon = viewerScope.useCommand(model.rejectFavicon$);
  return (
    <span className="cdpv-favicon" aria-hidden="true">
      {icon && !icon.failed && (
        <img
          key={icon.url}
          src={icon.url}
          onLoad={faviconImageLoaded}
          onError={() => rejectFavicon({ targetId, icon })}
          alt=""
          width={16}
          height={16}
          decoding="async"
          fetchPriority="low"
          referrerPolicy="no-referrer"
        />
      )}
      <Globe size={16} />
    </span>
  );
}
