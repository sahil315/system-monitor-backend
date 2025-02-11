const express = require("express");
const WebSocket = require("ws");
const axios = require("axios");
const cors = require("cors");
const os = require("os");
const fs = require("fs");
const { execSync } = require("child_process");
const app = express();
require("dotenv").config(); // Load environment variables

// app.use(cors({ origin: "*" })); // Allow any origin
app.use((req, res, next) => {
    console.log("Headers Received:", req.headers);  // Debug
    console.log("Received API Key:", req.headers["x-api-key"]);
    console.log("Expected API Key:", process.env.API_KEY);

    if (req.headers["x-api-key"] !== process.env.API_KEY) {
        console.warn("Unauthorized request detected!");
        return res.status(403).json({ error: "Unauthorized" });
    }
    next();
});
app.use(cors({
    origin: "*",
    allowedHeaders: ["x-api-key", "Content-Type", "Authorization"],
    exposedHeaders: ["x-api-key"]
}));
const server = require("http").createServer(app);
const wss = new WebSocket.Server({ server });

// Function to extract relevant sensor data
const extractSensorData = (node, type, output) => {
    if (!node.Children) return;

    node.Children.forEach(sensor => {
        if (sensor.Type === type) {
            output.push({ name: sensor.Text, value: sensor.Value });
        }
        extractSensorData(sensor, type, output);
    });
};
const API_URL = process.env.LIBRE_MONITOR_URL || "http://192.168.29.85:8086/data.json";

// const API_URL = process.env.LIBRE_MONITOR_URL || "https://400e-2405-201-5c0f-38-4148-1a66-3f1e-cb45.ngrok-free.app/data.json";  // Change this to your local IP

// Function to fetch system stats
const fetchSystemStats = async () => {
  try {
        console.log(`Fetching system stats from: ${API_URL}`);  // Debugging

        // const response = await axios.get(API_URL, { timeout: 5000 }); // Add timeout
        const response = await axios.get(API_URL, {
            auth: {
                username: "admin", 
                password: "newPassword"
            }
        });
        console.log("Received response:", response.data);  // Debug response

        if (!response.data || !response.data.Children) {
            throw new Error("Invalid response format from Libre Hardware Monitor.");
        }
        const systemData = response.data.Children[0]; // Main system data

        return { hostname: response.data.Children[0], os: os.platform(), uptime: os.uptime() };
    

        // Initialize data storage
        const cpu = { voltage: [], temp: [], load: [], fan_rpm: [], clock: [], power: [] };
        const motherboard = { voltages: [], temps: [], fans: [] };
        const ram = { load: "N/A", used: "N/A", available: "N/A" };
        const gpu = { fan_rpm: [], load: [], clock: [], memory: {}, temp: [] };
        const drives = [];
        const network = { sent: "N/A", received: "N/A", uploaded: "N/A", downloaded: "N/A", utilization: "N/A" };

        // Traverse system data
        if (systemData.Children) {
            systemData.Children.forEach((component) => {
                if (component.Text.includes("Gigabyte")) {
                    // Motherboard has an extra nested layer (ITE IT8689E)
                    const mbChip = component.Children[0]; // Drill down to ITE IT8689E
                    if (mbChip && mbChip.Children) {
                        mbChip.Children.forEach(sensorGroup => {
                            if (sensorGroup.Text === "Voltages") extractSensorData(sensorGroup, "Voltage", motherboard.voltages);
                            if (sensorGroup.Text === "Temperatures") extractSensorData(sensorGroup, "Temperature", motherboard.temps);
                            if (sensorGroup.Text === "Fans") extractSensorData(sensorGroup, "Fan", motherboard.fans);
                        });
                    }
                }

                if (component.Text.includes("Intel Core")) {
                    component.Children.forEach(sensorGroup => {
                        if (sensorGroup.Text === "Voltages") extractSensorData(sensorGroup, "Voltage", cpu.voltage);
                        if (sensorGroup.Text === "Temperatures") extractSensorData(sensorGroup, "Temperature", cpu.temp);
                        if (sensorGroup.Text === "Load") extractSensorData(sensorGroup, "Load", cpu.load);
                        if (sensorGroup.Text === "Fans") extractSensorData(sensorGroup, "Fan", cpu.fan_rpm);
                        if (sensorGroup.Text === "Clocks") extractSensorData(sensorGroup, "Clock", cpu.clock);
                        if (sensorGroup.Text === "Powers") extractSensorData(sensorGroup, "Power", cpu.power);
                    });
                }

                if (component.Text.includes("Memory")) {
                    component.Children.forEach(sensorGroup => {
                        if (sensorGroup.Text === "Load") {
                            ram.load = sensorGroup.Children[0]?.Value || "N/A";
                        }
                        if (sensorGroup.Text === "Data") {
                            ram.used = sensorGroup.Children.find(item => item.Text === "Memory Used")?.Value || "N/A";
                            ram.available = sensorGroup.Children.find(item => item.Text === "Memory Available")?.Value || "N/A";
                        }
                    });
                }

                if (component.Text.includes("NVIDIA GeForce")) {
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
                

                const getDrivePartitions = () => {
                    try {
                        let partitions = [];
                        const driveInfo = execSync("wmic logicaldisk get DeviceID,Size,FreeSpace").toString();
                        const lines = driveInfo.trim().split("\n").slice(1);
                
                        lines.forEach(line => {
                            const parts = line.trim().split(/\s+/);
                            if (parts.length === 3) {
                                const driveLetter = parts[0]; // C:, D:, etc.
                                const freeSpace = parseInt(parts[1], 10) / (1024 ** 3); // Free space in GB
                                const totalSpace = parseInt(parts[2], 10) / (1024 ** 3); // Total space in GB
                                const usedSpace = totalSpace - freeSpace; // Correctly calculate used space
                
                                partitions.push({
                                    name: driveLetter,
                                    total: totalSpace.toFixed(2) + " GB",
                                    used: usedSpace.toFixed(2) + " GB",
                                    free: freeSpace.toFixed(2) + " GB"
                                });
                            }
                        });
                
                        return partitions;
                    } catch (error) {
                        console.error("Error fetching drive partitions:", error);
                        return [];
                    }
                };
                
                // Modify this part in fetchSystemStats()
                if (component.Text.includes("WD Blue")) {
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
                            const usedSpace = sensorGroup.Children.find(item => item.Text === "Used Space")?.Value || "N/A";
                            driveData.used = usedSpace;
                        }
                        if (sensorGroup.Text === "Temperatures") {
                            const temp = sensorGroup.Children.find(item => item.Text === "Temperature")?.Value || "N/A";
                            driveData.temperature = temp;
                        }
                        if (sensorGroup.Text === "Throughput") {
                            driveData.read_speed = sensorGroup.Children.find(item => item.Text === "Read Rate")?.Value || "N/A";
                            driveData.write_speed = sensorGroup.Children.find(item => item.Text === "Write Rate")?.Value || "N/A";
                        }
                    });
                
                    // Ensure we push the drive data only if valid
                    drives.push(driveData);
                }

                if (component.Text === "Ethernet") {
                    component.Children.forEach(sensorGroup => {
                        if (sensorGroup.Text === "Load") {
                            const utilizationSensor = sensorGroup.Children.find(item => item.Text === "Network Utilization");
                            if (utilizationSensor) network.utilization = utilizationSensor.Value || "N/A";
                        }
                        if (sensorGroup.Text === "Data") {
                            console.log('data fro eth ' + JSON.stringify(sensorGroup.Children))
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
        }

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
        console.error("Failed to fetch system stats:", error.message);
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
wss.on("connection", async (ws) => {
    console.log("Client connected via WebSocket");

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
