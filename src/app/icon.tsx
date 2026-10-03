import { ImageResponse } from "next/og";

export const size = { width: 32, height: 32 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#0f1c24",
          color: "#2dd4bf",
          fontSize: 20,
          fontWeight: 700,
          borderRadius: 8,
        }}
      >
        P
      </div>
    ),
    size,
  );
}
