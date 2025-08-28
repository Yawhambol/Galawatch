import React, { useEffect, useMemo, useRef, useState } from "react";
import { v4 as uuidv4 } from "uuid";
import { MapContainer, TileLayer, Marker, Circle, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

/**
 * GALAMSEY REPORTER APP (Fixed Build Version)
 */

const DefaultIcon = new L.Icon({
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
});
(L.Marker.prototype as any).options.icon = DefaultIcon;

// Utility
const km = (m: number) => (m / 1000).toFixed(2);
const toRad = (d: number) => (d * Math.PI) / 180;
const haversine = (lat1: number, lon1: number, lat2: number, lon2: number) => {
  const R = 6371e3;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
};

// FitToBounds helper
function pointsKey(points: number[][]) {
  return points.map((p) => `${p[0].toFixed(6)},${p[1].toFixed(6)}`).join("|");
}
function FitToBounds({ points }: { points: number[][] }) {
  const map = useMap();
  const signature = useMemo(() => pointsKey(points), [points]);
  useEffect(() => {
    if (!map || points.length === 0) return;
    const latlngs = points.map((p) => L.latLng(p[0], p[1]));
    if (latlngs.length === 1) {
      map.setView(latlngs[0], 15);
    } else {
      const bounds = L.latLngBounds(latlngs);
      map.fitBounds(bounds, { padding: [40, 40] });
    }
  }, [map, signature]);
  return null;
}

// Demo Report type
type Report = {
  id: string;
  category: string;
  description: string;
  gps: { lat: number; lon: number };
};

export default function App() {
  const [tab, setTab] = useState<"report" | "my" | "map">("report");
  const [reports, setReports] = useState<Report[]>([]);
  const [userLoc, setUserLoc] = useState<{ lat: number; lon: number } | null>(
    null
  );

  useEffect(() => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => setUserLoc({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      () => {}
    );
  }, []);

  const addReport = () => {
    const id = uuidv4();
    const newReport: Report = {
      id,
      category: "Illegal Mining",
      description: "Test report",
      gps: { lat: 5.55, lon: -0.1969 },
    };
    setReports((prev) => [...prev, newReport]);
    setTab("my");
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="p-4 bg-white shadow flex justify-between">
        <h1 className="font-bold">Galamsey Reporter</h1>
        <nav className="space-x-2">
          <button onClick={() => setTab("report")}>New Report</button>
          <button onClick={() => setTab("my")}>My Reports</button>
          <button onClick={() => setTab("map")}>Map</button>
        </nav>
      </header>

      {tab === "report" && (
        <main className="p-4">
          <h2 className="text-lg font-semibold mb-2">Create Report</h2>
          <button
            className="px-4 py-2 bg-emerald-600 text-white rounded"
            onClick={addReport}
          >
            Submit Dummy Report
          </button>
        </main>
      )}

      {tab === "my" && (
        <main className="p-4">
          <h2 className="text-lg font-semibold mb-2">My Reports</h2>
          {reports.length === 0 && <p>No reports yet.</p>}
          {reports.map((r) => (
            <div key={r.id} className="border p-2 mb-2 rounded">
              <b>{r.category}</b> – {r.description}
              <br />
              GPS: {r.gps.lat}, {r.gps.lon}
            </div>
          ))}
        </main>
      )}

      {tab === "map" && (
        <main className="p-4">
          <h2 className="text-lg font-semibold mb-2">Map</h2>
          <div className="h-[400px] rounded overflow-hidden">
            <MapContainer
              center={userLoc ? [userLoc.lat, userLoc.lon] : [5.55, -0.1969]}
              zoom={12}
              style={{ height: "100%", width: "100%" }}
            >
              <TileLayer
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                attribution="© OpenStreetMap"
              />
              {userLoc && (
                <Marker position={[userLoc.lat, userLoc.lon]}></Marker>
              )}
              {reports.map((r) => (
                <Marker
                  key={r.id}
                  position={[r.gps.lat, r.gps.lon]}
                ></Marker>
              ))}
              <FitToBounds
                points={[
                  ...(userLoc ? [[userLoc.lat, userLoc.lon]] : []),
                  ...reports.map((r) => [r.gps.lat, r.gps.lon]),
                ]}
              />
            </MapContainer>
          </div>
        </main>
      )}
    </div>
  );
}

