import Svg, { Path } from "react-native-svg";
import { useColors } from "@/lib/theme";

/** The Family Drive mark (same paths as the web Logo). */
export function Logo({ size = 64 }: { size?: number }) {
  const c = useColors();
  return (
    <Svg width={size} height={size} viewBox="38 14 224 224">
      <Path fill={c.logoAccent} d="M202 116 212 108C232 118 239 134 239 150 239 176 227 194 205 194H186C198 194 202 188 202 176Z" />
      <Path
        fill="none"
        stroke={c.logoInk}
        strokeWidth={19}
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M52 131 150 50l62 51c22 8 35 27 35 49 0 29-18 52-44 52H100c-10 0-16-6-16-16V68"
      />
      <Path fill={c.logoInk} d="M115 131c0-4 3-6 6-6h17l6 6h26c4 0 6 3 6 6v22c0 4-2 6-6 6h-49c-4 0-6-2-6-6z" />
    </Svg>
  );
}
