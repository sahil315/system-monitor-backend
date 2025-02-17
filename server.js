const express = require("express");
const WebSocket = require("ws");
const axios = require("axios");
const cors = require("cors");
const os = require("os");
require("dotenv").config(); // Load environment variables
const diskusage = require("diskusage"); // ✅ Using diskusage


const app = express();

// ✅ Allow CORS
app.use(cors({
    origin: "*",
    allowedHeaders: ["x-api-key", "Content-Type", "Authorization"],
    exposedHeaders: ["x-api-key"]
}));

// ✅ Middleware for API Key Authentication
app.use((req, res, next) => {
    const receivedKey = req.headers["x-api-key"];
    const expectedKey = process.env.API_KEY;

    if (!receivedKey || receivedKey !== expectedKey) {
        console.warn("🚨 Unauthorized request detected!");
        return res.status(403).json({ error: "Unauthorized" });
    }
    next();
});

let storedPartitions = []; // ✅ Store partitions received from local machine

const server = require("http").createServer(app);
const wss = new WebSocket.Server({ server });

const API_URL = "https://libre.pcstats.site/data.json";

// ✅ Extract Sensor Data
const extractSensorData = (node, type, output, keyMap = null) => {
    if (!node.Children) return;
    
    node.Children.forEach(sensor => {
        if (sensor.Type === type) {
            if (keyMap && keyMap[sensor.Text]) {
                output[keyMap[sensor.Text]] = sensor.Value || "N/A";
            } else {
                output.push({ name: sensor.Text, value: sensor.Value });
            }
        }
        extractSensorData(sensor, type, output, keyMap);
    });
};

// ✅ Fetch Storage Data Using diskusage
// const getDriveUsage = () => {
//     let partitions = [];
//     let drives = ["C:", "D:", "F:"]; // ✅ Fetch only these partitions

//     drives.forEach(drive => {
//         try {
//             const { free, total } = diskusage.checkSync(drive);
//             const used = total - free;

//             partitions.push({
//                 name: drive,
//                 total: (total / 1e9).toFixed(2) + " GB",
//                 free: (free / 1e9).toFixed(2) + " GB",
//                 used: (used / 1e9).toFixed(2) + " GB",
//                 percentUsed: total > 0 ? ((used / total) * 100).toFixed(1) + "%" : "0%"
//             });
//         } catch (error) {
//             console.error(`❌ Error fetching data for ${drive}:`, error.message);
//         }
//     });

//     return partitions;
// };




// ✅ Function to Fetch System Stats
const fetchSystemStats = async () => {
    try {
        // console.log(`📡 Fetching system stats from: ${API_URL}`);
        const response = await axios.get(API_URL, {
            auth: { username: "admin", password: "newPassword" }
        });

        if (!response.data || !response.data.Children) {
            throw new Error("Invalid response format from Libre Hardware Monitor.");
        }

        const systemData = response.data.Children[0];
        console.log('systemData   -----', JSON.stringify(response.data));
        // ✅ Fetch Storage Data (Drives are now stored separately)
        const partitions = getDriveUsage();
        console.log('partitions' + JSON.stringify(partitions));
        // ✅ Initialize data storage
        const cpu = { voltage: [], temp: [], load: [], fan_rpm: [], clock: [], power: [] };
        const motherboard = { voltages: [], temps: [], fans: [] };
        // const ram = { load: "N/A", used: "N/A", available: "N/A" };
        const ram = { 
            load: "N/A", 
            virtual_load: "N/A", 
            used: "N/A", 
            available: "N/A", 
            virtual_used: "N/A", 
            virtual_available: "N/A" 
        };
        const gpu = { fan_rpm: [], load: [], clock: [], memory: {}, temp: [] };
       
        const network = { sent: "N/A", received: "N/A", uploaded: "N/A", downloaded: "N/A", utilization: "N/A" };
       let drives = [];

        let wdBlueDrive = {
            name: "WD Blue SN580 2TB",
            used: "N/A",
            temperature: "N/A",
            read_speed: "N/A",
            write_speed: "N/A"
        };

        // ✅ Store only one instance of `WD Blue SN580 2TB`
        if (!drives.some(drive => drive.name === wdBlueDrive.name)) {
            drives.push(wdBlueDrive);
        }
        // ✅ Traverse System Data
        systemData.Children.forEach((component) => {
            if (component.Text.includes("Gigabyte")) {
                const mbChip = component.Children[0];
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
            // if (component.Text.includes("Memory")) {
            //     component.Children.forEach(sensorGroup => {
            //         if (sensorGroup.Text === "Load") {
            //             ram.load = sensorGroup.Children[0]?.Value || "N/A";
            //         }
            //         if (sensorGroup.Text === "Data") {
            //             ram.used = sensorGroup.Children.find(item => item.Text === "Memory Used")?.Value || "N/A";
            //             ram.available = sensorGroup.Children.find(item => item.Text === "Memory Available")?.Value || "N/A";
            //         }
            //     });
            // }
            if (component.Text.includes("Memory")) {
                component.Children.forEach(sensorGroup => {
                    if (sensorGroup.Text === "Load") {
                        ram.load = sensorGroup.Children.find(item => item.Text === "Memory")?.Value || "N/A";
                        ram.virtual_load = sensorGroup.Children.find(item => item.Text === "Virtual Memory")?.Value || "N/A";
                    }
                    if (sensorGroup.Text === "Data") {
                        ram.used = sensorGroup.Children.find(item => item.Text === "Memory Used")?.Value || "N/A";
                        ram.available = sensorGroup.Children.find(item => item.Text === "Memory Available")?.Value || "N/A";
                        ram.virtual_used = sensorGroup.Children.find(item => item.Text === "Virtual Memory Used")?.Value || "N/A";
                        ram.virtual_available = sensorGroup.Children.find(item => item.Text === "Virtual Memory Available")?.Value || "N/A";
                    }
                });
            }
            if (component.Text.includes("Ethernet")) {
                console.log("📡 Found Ethernet Component:", JSON.stringify(component, null, 2));
            
                component.Children.forEach(sensorGroup => {
                    console.log("🔍 Found Sensor Group:", sensorGroup.Text);
                });
            }
               if (component.id === 188) {
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


                
                // Modify this part in fetchSystemStats()
               if (component.Text.includes("WD Blue")) {
                component.Children.forEach(sensorGroup => {
                    if (sensorGroup.Text === "Load") {
                        wdBlueDrive.used = sensorGroup.Children.find(item => item.Text === "Used Space")?.Value || "N/A";
                    }
                    if (sensorGroup.Text === "Temperatures") {
                        wdBlueDrive.temperature = sensorGroup.Children.find(item => item.Text === "Temperature")?.Value || "N/A";
                    }
                    if (sensorGroup.Text === "Throughput") {
                        wdBlueDrive.read_speed = sensorGroup.Children.find(item => item.Text === "Read Rate")?.Value || "N/A";
                        wdBlueDrive.write_speed = sensorGroup.Children.find(item => item.Text === "Write Rate")?.Value || "N/A";
                    }
                });
            }
        // ✅ Keep only WD Blue in `drives` array
        // drives.push(wdBlueDrive);


           
        });

        return { hostname: systemData.Text, os: os.platform(), uptime: os.uptime(), network, cpu, motherboard, ram, gpu, drives, partitions: storedPartitions  };
    } catch (error) {
        console.error("⚠️ Failed to fetch system stats:", error.message);
        return null;
    }
};

// ✅ Store last sent system stats
let previousStats = null;

// ✅ Function to detect changed values
const getChangedValues = (newStats, oldStats) => {
    if (!oldStats) return newStats; // First-time connection, send all data

    let changedStats = {};
    for (let key in newStats) {
        if (JSON.stringify(newStats[key]) !== JSON.stringify(oldStats[key])) {
            changedStats[key] = newStats[key]; // Send only changed values
        }
    }
    return Object.keys(changedStats).length > 0 ? changedStats : null;
};

// ✅ WebSocket Connection Handling
wss.on("connection", async (ws) => {
    console.log("✅ New WebSocket connection established.");

    ws.on("message", async (message) => {
        try {
            const data = JSON.parse(message);
            if (!data.api_key || data.api_key !== process.env.API_KEY) {
                console.warn("🚨 WebSocket Unauthorized request!");
                ws.close(1008, "Unauthorized");
                return;
            }
            console.log("✅ WebSocket authenticated successfully.");

            // Send full data on first connection
            const fullStats = await fetchSystemStats();
            ws.send(JSON.stringify(fullStats));
            previousStats = fullStats;

            // Function to send only changed stats
            const sendStats = async () => {
                try {
                    const newStats = await fetchSystemStats();
                    const changedStats = getChangedValues(newStats, previousStats);

                    if (changedStats) {
                        ws.send(JSON.stringify(changedStats));
                        previousStats = newStats;
                    }
                } catch (err) {
                    console.error("❌ Error sending stats:", err);
                }
            };

            // Send updates every second
            const interval = setInterval(sendStats, 1000);

            ws.on("close", () => {
                console.log("⚠️ WebSocket connection closed.");
                clearInterval(interval);
            });

        } catch (error) {
            console.error("❌ Error parsing WebSocket message:", error);
        }
    });
});

// ✅ REST API Endpoint
app.get("/stats", async (req, res) => {
    try {
        const stats = await fetchSystemStats();
        res.json(stats);
    } catch (err) {
        res.status(500).json({ error: "Failed to fetch system stats" });
    }
});


app.post("/api/partitions", (req, res) => {
    if (!req.body.partitions) {
        return res.status(400).json({ error: "No partition data received" });
    }

    storedPartitions = req.body.partitions;
    console.log("✅ Updated partitions:", storedPartitions);
    res.json({ message: "Partitions updated successfully" });
});

// ✅ API Endpoint to Serve Partitions
app.get("/api/partitions", (req, res) => {
    res.json({ partitions: storedPartitions });
});


// ✅ Start the Server
const PORT = 5000;
server.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
