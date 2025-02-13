const express = require("express");
const WebSocket = require("ws");
const axios = require("axios");
const cors = require("cors");
const os = require("os");
const fs = require("fs");
const { execSync } = require("child_process");
require("dotenv").config(); // Load environment variables
const app = express();

// ✅ Allow CORS for `api.pcstats.site`
app.use(cors({
    origin: "*",
    allowedHeaders: ["x-api-key", "Content-Type", "Authorization"],
    exposedHeaders: ["x-api-key"]
}));

// ✅ Middleware for API Key Authentication
app.use((req, res, next) => {
    console.log("🔹 Headers Received:", req.headers);  // Debugging
    const receivedKey = req.headers["x-api-key"];
    const expectedKey = process.env.API_KEY;

    console.log("🔹 Received API Key:", receivedKey);
    console.log("🔹 Expected API Key:", expectedKey);

    if (!receivedKey || receivedKey !== expectedKey) {
        console.warn("🚨 Unauthorized request detected!");
        return res.status(403).json({ error: "Unauthorized" });
    }
    next();
});

const server = require("http").createServer(app);
const wss = new WebSocket.Server({ server });

// ✅ New Libre Monitor API URL (No Auth Required)
const API_URL = "https://libre.pcstats.site/data.json";

// ✅ Function to Fetch System Stats from Libre Monitor
const fetchSystemStats = async () => {
    try {
        console.log(`📡 Fetching system stats from: ${API_URL}`);

        const response = await axios.get(API_URL);

        console.log("✅ Received response:", response.data);

        if (!response.data || !response.data.Children) {
            throw new Error("Invalid response format from Libre Hardware Monitor.");
        }

        const systemData = response.data.Children[0]; // Main system data

        // ✅ Initialize structured data
        const cpu = { voltage: [], temp: [], load: [], fan_rpm: [], clock: [], power: [] };
        const motherboard = { voltages: [], temps: [], fans: [] };
        const ram = { load: "N/A", used: "N/A", available: "N/A" };
        const gpu = { fan_rpm: [], load: [], clock: [], memory: {}, temp: [] };
        const drives = [];
        const network = { sent: "N/A", received: "N/A", uploaded: "N/A", downloaded: "N/A", utilization: "N/A" };

        // ✅ Traverse and extract relevant data
        systemData.Children.forEach((component) => {
            if (component.Text.includes("Gigabyte") || component.Text.includes("Motherboard")) {
                const mbChip = component.Children[0]; // Drill down
                if (mbChip?.Children) {
                    mbChip.Children.forEach(sensorGroup => {
                        if (sensorGroup.Text === "Voltages") extractSensorData(sensorGroup, "Voltage", motherboard.voltages);
                        if (sensorGroup.Text === "Temperatures") extractSensorData(sensorGroup, "Temperature", motherboard.temps);
                        if (sensorGroup.Text === "Fans") extractSensorData(sensorGroup, "Fan", motherboard.fans);
                    });
                }
            }

            if (component.Text.includes("Intel Core") || component.Text.includes("CPU")) {
                component.Children.forEach(sensorGroup => {
                    if (sensorGroup.Text === "Voltages") extractSensorData(sensorGroup, "Voltage", cpu.voltage);
                    if (sensorGroup.Text === "Temperatures") extractSensorData(sensorGroup, "Temperature", cpu.temp);
                    if (sensorGroup.Text === "Load") extractSensorData(sensorGroup, "Load", cpu.load);
                    if (sensorGroup.Text === "Fans") extractSensorData(sensorGroup, "Fan", cpu.fan_rpm);
                    if (sensorGroup.Text === "Clocks") extractSensorData(sensorGroup, "Clock", cpu.clock);
                    if (sensorGroup.Text === "Powers") extractSensorData(sensorGroup, "Power", cpu.power);
                });
            }

            if (component.Text.includes("Memory") || component.Text.includes("RAM")) {
                component.Children.forEach(sensorGroup => {
                    if (sensorGroup.Text === "Load") ram.load = sensorGroup.Children[0]?.Value || "N/A";
                    if (sensorGroup.Text === "Data") {
                        ram.used = sensorGroup.Children.find(item => item.Text === "Memory Used")?.Value || "N/A";
                        ram.available = sensorGroup.Children.find(item => item.Text === "Memory Available")?.Value || "N/A";
                    }
                });
            }

            if (component.Text.includes("NVIDIA GeForce") || component.Text.includes("GPU")) {
                component.Children.forEach(sensorGroup => {
                    if (sensorGroup.Text === "Clocks") extractSensorData(sensorGroup, "Clock", gpu.clock);
                    if (sensorGroup.Text === "Temperatures") extractSensorData(sensorGroup, "Temperature", gpu.temp);
                    if (sensorGroup.Text === "Load") extractSensorData(sensorGroup, "Load", gpu.load);
                    if (sensorGroup.Text === "Fans") extractSensorData(sensorGroup, "Fan", gpu.fan_rpm);
                    if (sensorGroup.Text === "Data") {
                        sensorGroup.Children.forEach(memSensor => {
                            gpu.memory[memSensor.Text] = memSensor.Value;
                        });
                    }
                });
            }

            if (component.Text.includes("WD Blue") || component.Text.includes("SSD")) {
                let driveData = {
                    name: "WD Blue SN580",
                    used: "N/A",
                    partitions: getDrivePartitions(),
                    temperature: "N/A",
                    read_speed: "N/A",
                    write_speed: "N/A"
                };

                component.Children.forEach(sensorGroup => {
                    if (sensorGroup.Text === "Load") {
                        driveData.used = sensorGroup.Children.find(item => item.Text === "Used Space")?.Value || "N/A";
                    }
                    if (sensorGroup.Text === "Temperatures") {
                        driveData.temperature = sensorGroup.Children.find(item => item.Text === "Temperature")?.Value || "N/A";
                    }
                    if (sensorGroup.Text === "Throughput") {
                        driveData.read_speed = sensorGroup.Children.find(item => item.Text === "Read Rate")?.Value || "N/A";
                        driveData.write_speed = sensorGroup.Children.find(item => item.Text === "Write Rate")?.Value || "N/A";
                    }
                });

                drives.push(driveData);
            }

            if (component.Text.includes("Ethernet") || component.Text.includes("Network")) {
                component.Children.forEach(sensorGroup => {
                    if (sensorGroup.Text === "Load") {
                        const utilizationSensor = sensorGroup.Children.find(item => item.Text === "Network Utilization");
                        if (utilizationSensor) network.utilization = utilizationSensor.Value || "N/A";
                    }
                    if (sensorGroup.Text === "Data") {
                        sensorGroup.Children.forEach(sensor => {
                            if (sensor.Text.includes("Data Uploaded")) network.uploaded = sensor.Value || "N/A";
                            if (sensor.Text.includes("Data Downloaded")) network.downloaded = sensor.Value || "N/A";
                        });
                    }
                    if (sensorGroup.Text === "Throughput") {
                        sensorGroup.Children.forEach(sensor => {
                            if (sensor.Text.includes("Upload Speed")) network.sent = sensor.Value || "N/A";
                            if (sensor.Text.includes("Download Speed")) network.received = sensor.Value || "N/A";
                        });
                    }
                });
            }
        });

        // ✅ Return structured stats
        return {
            hostname: systemData.Text,
            os: os.platform(),
            uptime: os.uptime(),
            cpu,
            motherboard,
            ram,
            gpu,
            drives,
            network
        };
    } catch (error) {
        console.error("⚠️ Failed to fetch system stats:", error.message);
        return null;
    }
};


// SSE Stream
app.get("/stream", async (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const sendStats = async () => {
        try {
            const stats = await fetchSystemStats();
            res.write(`data: ${JSON.stringify(stats)}\n\n`);
        } catch (err) {
            console.error("Error fetching stats:", err);
        }
    };

    const interval = setInterval(sendStats, 1000);
    sendStats();

    req.on("close", () => clearInterval(interval));
});

// WebSocket
wss.on("connection", (ws) => {
    console.log("New WebSocket connection established.");

    ws.on("message", (message) => {
        try {
            const data = JSON.parse(message);
            if (!data.api_key || data.api_key !== process.env.API_KEY) {
                console.warn("WebSocket Unauthorized request!");
                ws.close(1008, "Unauthorized");
                return;
            }
            console.log("WebSocket authenticated successfully.");

            const sendStats = async () => {
                try {
                    const stats = await fetchSystemStats();
                    ws.send(JSON.stringify(stats));
                } catch (err) {
                    console.error("Error sending stats:", err);
                }
            };

            const interval = setInterval(sendStats, 1000);
            sendStats();

            ws.on("close", () => clearInterval(interval));
        } catch (error) {
            console.error("Error parsing WebSocket message:", error);
        }
    });
});

// REST API
app.get("/stats", async (req, res) => {
    try {
        const stats = await fetchSystemStats();
        res.json(stats);
    } catch (err) {
        res.status(500).json({ error: "Failed to fetch system stats" });
    }
});

// // Start Server
// server.listen(5000, () => {
//     console.log("Server running on http://localhost:5000");
// });

const PORT = 5000;
const HOST = "0.0.0.0"; // Listen on all interfaces

server.listen(PORT, HOST, () => {
    console.log(`Server running on http://${HOST}:${PORT}`);
});
