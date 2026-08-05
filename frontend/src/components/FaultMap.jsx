import { useEffect, useState, useRef } from 'react';
import { MapContainer, TileLayer, CircleMarker, Popup, useMap } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import { fetchPoles, fetchTransformers } from '../utils/api';

// Component to fly to a ticket location
function FlyToTicket({ lat, lon }) {
  const map = useMap();
  useEffect(() => {
    if (lat && lon) {
      map.flyTo([lat, lon], 16, { duration: 1 });
    }
  }, [lat, lon, map]);
  return null;
}

function FaultMap({ tickets, selectedTicket, onTicketSelect }) {
  const [poles, setPoles] = useState([]);
  const [transformers, setTransformers] = useState([]);
  const [center, setCenter] = useState([12.9716, 77.5946]); // Bangalore default

  useEffect(() => {
    async function load() {
      try {
        const [polesData, dtData] = await Promise.all([
          fetchPoles(),
          fetchTransformers(),
        ]);
        setPoles(polesData);
        setTransformers(dtData);

        // Center map on the average position of all DTs
        if (dtData.length > 0) {
          const avgLat = dtData.reduce((s, d) => s + parseFloat(d.lat), 0) / dtData.length;
          const avgLon = dtData.reduce((s, d) => s + parseFloat(d.lon), 0) / dtData.length;
          setCenter([avgLat, avgLon]);
        }
      } catch (err) {
        console.error('Map data load error:', err);
      }
    }
    load();
  }, []);

  // Refresh pole states periodically
  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const polesData = await fetchPoles();
        setPoles(polesData);
      } catch (err) {
        // ignore
      }
    }, 10000);
    return () => clearInterval(interval);
  }, []);

  const selectedTicketData = tickets?.find(t => t.ticket_id === selectedTicket);

  // Determine pole color
  const getPoleColor = (pole) => {
    if (!pole.has_device) return '#3a4570'; // no sensor — grey-blue
    if (pole.device_status === 'offline') return '#6b7280'; // dead modem — grey
    if (pole.energized === false || pole.device_status === 'overdue') return '#ef4444'; // dark — red
    return '#10b981'; // live — green
  };

  const getPoleRadius = (pole) => {
    if (pole.energized === false || pole.device_status === 'overdue') return 5;
    return 3;
  };

  return (
    <MapContainer
      center={center}
      zoom={14}
      style={{ height: '100%', width: '100%' }}
      zoomControl={true}
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />

      {/* Fly to selected ticket */}
      {selectedTicketData && selectedTicketData.lat && (
        <FlyToTicket lat={selectedTicketData.lat} lon={selectedTicketData.lon} />
      )}

      {/* DT markers */}
      {transformers.map(dt => (
        <CircleMarker
          key={dt.dt_id}
          center={[parseFloat(dt.lat), parseFloat(dt.lon)]}
          radius={8}
          pathOptions={{
            color: parseInt(dt.dark_count) > 0 ? '#ef4444' : '#3b82f6',
            fillColor: parseInt(dt.dark_count) > 0 ? '#ef4444' : '#3b82f6',
            fillOpacity: 0.6,
            weight: 2,
          }}
        >
          <Popup>
            <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 12 }}>
              <strong>🏗️ {dt.dt_id}</strong><br/>
              Feeder: {dt.feeder_id}<br/>
              Poles: {dt.pole_count} ({dt.dark_count} dark)<br/>
              Topology: {dt.has_topology ? '✅ Available' : '❌ Missing'}<br/>
              Capacity: {dt.capacity_kva} kVA<br/>
              Households: {dt.households_served}
            </div>
          </Popup>
        </CircleMarker>
      ))}

      {/* Pole markers (only at higher zoom levels for performance) */}
      {poles.map(pole => (
        <CircleMarker
          key={pole.pole_id}
          center={[parseFloat(pole.lat), parseFloat(pole.lon)]}
          radius={getPoleRadius(pole)}
          pathOptions={{
            color: getPoleColor(pole),
            fillColor: getPoleColor(pole),
            fillOpacity: 0.7,
            weight: 1,
          }}
        >
          <Popup>
            <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 12 }}>
              <strong>📍 {pole.pole_id}</strong><br/>
              DT: {pole.dt_id}<br/>
              Status: {pole.energized === false ? '🔴 Dark' : pole.device_status === 'overdue' ? '⏰ Overdue' : pole.has_device ? '🟢 Live' : '⚪ No sensor'}<br/>
              {pole.device_id && <>Device: {pole.device_id}<br/></>}
              {pole.firmware && <>Firmware: {pole.firmware}<br/></>}
              {pole.seq_on_line && <>Seq: {pole.seq_on_line}<br/></>}
              {pole.parent_pole_id && <>Parent: {pole.parent_pole_id}<br/></>}
              PIN: {pole.pincode || 'N/A'}<br/>
              Coords: {parseFloat(pole.lat).toFixed(6)}, {parseFloat(pole.lon).toFixed(6)}
            </div>
          </Popup>
        </CircleMarker>
      ))}

      {/* Fault location markers — large pulsing red circles */}
      {tickets?.filter(t => t.lat && t.lon && t.status !== 'closed').map(ticket => (
        <CircleMarker
          key={`fault-${ticket.ticket_id}`}
          center={[parseFloat(ticket.lat), parseFloat(ticket.lon)]}
          radius={15}
          pathOptions={{
            color: ticket.status === 'verified' ? '#10b981' : '#ef4444',
            fillColor: ticket.status === 'verified' ? '#10b981' : '#ef4444',
            fillOpacity: 0.3,
            weight: 3,
            dashArray: ticket.confidence === 'high' ? '' : '5,5',
          }}
          eventHandlers={{
            click: () => onTicketSelect(ticket.ticket_id),
          }}
        >
          <Popup>
            <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 12 }}>
              <strong>🚨 {ticket.ticket_id}</strong><br/>
              Type: {ticket.fault_type}<br/>
              Status: {ticket.status}<br/>
              Confidence: {ticket.confidence}<br/>
              Affected: {ticket.affected_poles_count} poles<br/>
              PIN: {ticket.pincode || 'N/A'}
            </div>
          </Popup>
        </CircleMarker>
      ))}
    </MapContainer>
  );
}

export default FaultMap;
