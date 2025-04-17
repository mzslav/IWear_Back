const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const path = require("path");
const Busboy = require('busboy');
const os = require("os");
const fs = require("fs");
const serviceAccount = require("./serviceAccountKey.json");
const { Timestamp, FieldValue } = require('firebase-admin/firestore'); 
const { getStorage } = require("firebase-admin/storage");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  storageBucket: "" 
});

const bucket = admin.storage().bucket();
const db = admin.firestore();
const colRef = db.collection("users");


const checkAuth = (req) => {
  return new Promise((resolve, reject) => {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return reject({ status: 401, message: "Unauthorized: Token not provided" });
    }

    const idToken = authHeader.split("Bearer ")[1];

    admin
      .auth()
      .verifyIdToken(idToken)
      .then((decodedToken) => {
        resolve(decodedToken.uid); 
      })
      .catch((error) => {
        reject({ status: 401, message: "Unauthorized: Invalid token", error });
      });
  });
};

async function AIAnalyzeOutFit(prompt, dbdata) {
  
  const openRouterApi = process.env.openRouterApi
  
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${openRouterApi}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      "model": "deepseek/deepseek-chat:free",
      "messages": [
        {
          "role": "user",
          "content": [
            {
              "type": "text",
              "text": `${prompt}, ${JSON.stringify(dbdata)}`
            },
          ]
        }
      ]
    })
  });

  if (!response.ok) {
    throw new Error(`OpenRouter API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  const messageObj = data.choices?.[0]?.message;
  if (!messageObj || !messageObj.content) {
    throw new Error("Empty response from AI model.");
  }

  let cleanContent = messageObj.content.replace(/^```json\n/, "").replace(/\n```$/, "").trim();
  let jsonResponse;
  try {
    jsonResponse = JSON.parse(cleanContent);
  } catch (error) {
    console.error("Parsing error:", error, "Content received:", cleanContent);
    throw new Error("Failed to parse JSON response. Check AI response format.");
  }

  return jsonResponse;  
}

async function getItemsFromFolder(uid,category) {
  const clothesRef = db.collection(`users/${uid}/items/${category}/clothes`);
    const snapshot = await clothesRef.get();

    if (snapshot.empty) {
      console.log("Collection 'items' is empty.");
      return [];
    }

    let data = [];
    snapshot.forEach((doc) => {
      data.push({ id: doc.id, ...doc.data() });
    });

    return data;
  
}

async function getWeather(city) {
  const apiKey = process.env.apiKeyOpenWeather
  const url = `https://api.openweathermap.org/data/2.5/weather?q=${city}&appid=${apiKey}&units=metric`; 

  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Error fetching data: ${response.statusText}`);
    }

    const data = await response.json();

    const temperature = data.main.temp;
    const description = data.weather[0].description;

    return { temperature, description };

  } catch (error) {
    console.error('Error:', error);
    throw error;
  }
}

exports.SetGetCity = onRequest({ cors: true }, async (req, res) => {
  try {
    const uid = await checkAuth(req); 
    const { city } = req.body;
    const userRef = colRef.doc(uid);
    
    if (city) {
      await userRef.set({ city }, { merge: true });
      return res.status(200).json({
        status: "success",
        message: "City updated successfully"
      });
    } 

    const userDoc = await userRef.get();
    if (!userDoc.exists) {
      return res.status(404).json({
        status: "error",
        message: "User not found"
      });
    }

    const userData = userDoc.data();
    return res.status(200).json({
      status: "success",
      city: userData.city || 'Kyiv'
    });

  } catch (error) {
    console.error("Error in SetGetCity:", error);
    return res.status(500).json({
      status: "error",
      message: "Internal server error"
    });
  }
});


exports.UploadImage = onRequest({ cors: true }, async (req, res) => {
  try {
    const uid = await checkAuth(req);
    const { tempFilePath, name, type, subtype, color, outfit_Style } = req.body;
    
    if (!tempFilePath || !name || !type || !subtype || !color || !outfit_Style) {
      return res.status(400).json({
        status: "error",
        message: "Missing required fields"
      });
    }
    
    const fileName = tempFilePath.split("/").pop();
    const permanentPath = `uploads/${uid}/${fileName}`;
    
    await bucket.file(tempFilePath).move(permanentPath);
    
    const fileUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/uploads%2F${uid}%2F${encodeURIComponent(fileName)}?alt=media`;
    let Item_Category = "Default";
    const userDoc = await colRef.doc(uid).get();
    const itemData = {
      imageUrl: fileUrl,
      type,
      subtype,
      color,
      outfit_Style,
      outfit_Style_Priority : {},
      name,
      addedAt: Timestamp.now()

    };
    
    if (itemData.type == "T-shirt" || itemData.type == "Shirt" || itemData.type == "Top") {
      Item_Category = "LightWeightMainItem";
    
      const priorityMap = {
        "Oversized T-shirt": { "Casual": 1, "Sporty": 2, "Official": 3 },
        "Polo Shirt": { "Official": 1, "Casual": 2, "Sporty": 3 },
        "Henley": { "Casual": 1, "Official": 2, "Sporty": 3 },
        "Classic Dress Shirt": { "Official": 1, "Casual": 2, "Sporty": 3 },
        "Casual Button-Up Shirt": { "Casual": 1, "Official": 2, "Sporty": 3 },
        "Flannel Shirt": { "Casual": 1, "Sporty": 2, "Official": 3 },
        "Tank Top": { "Sporty": 1, "Casual": 2, "Official": 3 },
        "Blouse": { "Official": 1, "Casual": 2, "Sporty": 3 },
        "Crop Top": { "Casual": 1, "Sporty": 2, "Official": 3 },
        "Camisole": { "Casual": 1, "Official": 2, "Sporty": 3 }
      };
    
      itemData.outfit_Style_Priority = priorityMap[itemData.subtype] || {};
    } 
    
    else if (itemData.type == "Sweater" || itemData.type == "Jacket") {
      Item_Category = "HeavyWeightMainItem";
    
      const priorityMap = {
        "Pullover Hoodie": { "Casual": 1, "Sporty": 2, "Official": 3 },
        "Zip-Up Hoodie": { "Casual": 1, "Sporty": 2, "Official": 3 },
        "Turtleneck Sweater": { "Official": 1, "Casual": 2, "Sporty": 3 },
        "Sweater": { "Casual": 1, "Official": 2, "Sporty": 3 },
        "Zip Sweater": { "Casual": 1, "Official": 2, "Sporty": 3 },
        "Leather Jacket": { "Casual": 1, "Official": 2, "Sporty": 3 },
        "Denim Jacket": { "Casual": 1, "Sporty": 2, "Official": 3 },
        "Puffer": { "Sporty": 1, "Casual": 2, "Official": 3 },
        "Windbreaker": { "Sporty": 1, "Casual": 2, "Official": 3 },
        "Fleece Jacket": { "Sporty": 1, "Casual": 2, "Official": 3 },
        "Vest": { "Official": 1, "Casual": 2, "Sporty": 3 },
        "Blazer": { "Official": 1, "Casual": 2, "Sporty": 3 }
      };
    
      itemData.outfit_Style_Priority = priorityMap[itemData.subtype] || {};
    } 
    
    else if (itemData.type == "Shorts" || itemData.type == "Skirt") {
      Item_Category = "LightWeightSecondItem";
    
      const priorityMap = {
        "Denim Shorts": { "Casual": 1, "Sporty": 2, "Official": 3 },
        "Chino Shorts": { "Casual": 1, "Official": 2, "Sporty": 3 },
        "Athletic Shorts": { "Sporty": 1, "Casual": 2, "Official": 3 },
        "Skirt": { "Official": 1, "Casual": 2, "Sporty": 3 },
        "Mini Skirt": { "Casual": 1, "Official": 2, "Sporty": 3 },
        "Denim Skirt": { "Casual": 1, "Sporty": 2, "Official": 3 }
      };
    
      itemData.outfit_Style_Priority = priorityMap[itemData.subtype] || {};
    } 
    
    else if (itemData.type == "Trousers" || itemData.type == "Dress") {
      Item_Category = "HeavyWeightSecondItem";
    
      const priorityMap = {
        "Jeans": { "Casual": 1, "Sporty": 2, "Official": 3 },
        "Dress Pants": { "Official": 1, "Casual": 2, "Sporty": 3 },
        "Cargo Pants": { "Casual": 1, "Sporty": 2, "Official": 3 },
        "Joggers": { "Sporty": 1, "Casual": 2, "Official": 3 },
        "Dress": { "Official": 1, "Casual": 2, "Sporty": 3 }
      };
    
      itemData.outfit_Style_Priority = priorityMap[itemData.subtype] || {};
    } 
    
    else if (["Boots", "Classic shoes", "Sports shoes", "Summer shoes"].includes(itemData.type)) {
      Item_Category = "ThirdItem";
    
      const priorityMap = {
        "Boots": { "Casual": 1, "Official": 2, "Sporty": 3 },
        "Chelsea Boots": { "Official": 1, "Casual": 2, "Sporty": 3 },
        "Ugg Boots": { "Casual": 1, "Sporty": 2, "Official": 3 },
        "Dress Shoes": { "Official": 1, "Casual": 2, "Sporty": 3 },
        "Loafers": { "Official": 1, "Casual": 2, "Sporty": 3 },
        "Pumps": { "Official": 1, "Casual": 2, "Sporty": 3 },
        "Wedges": { "Official": 1, "Casual": 2, "Sporty": 3 },
        "Sneakers": { "Sporty": 1, "Casual": 2, "Official": 3 },
        "Flip-Flops": { "Casual": 1, "Sporty": 2, "Official": 3 },
        "Ballet Flats": { "Casual": 1, "Official": 2, "Sporty": 3 }
      };
    
      itemData.outfit_Style_Priority = priorityMap[itemData.subtype] || {};
    } 
    
    else if (itemData.type == "Headdress") {
      Item_Category = "FourCategory";
    
      const priorityMap = {
        "Bucket Hat": { "Casual": 1, "Sporty": 2, "Official": 3 },
        "Baseball Cap": { "Sporty": 1, "Casual": 2, "Official": 3 },
        "Beanie": { "Casual": 1, "Sporty": 2, "Official": 3 }
      };
    
      itemData.outfit_Style_Priority = priorityMap[itemData.subtype] || {};
    }
    
    itemData.Item_Category = Item_Category;


    
    if (userDoc.exists) {
      const categoryRef = userDoc.ref.collection("items").doc(Item_Category).collection("clothes");
      await categoryRef.add(itemData);
      console.log("Item uploaded and saved in category:", Item_Category);
    } else {
      const userRef = db.collection("users").doc(uid);
      await userRef.set({ createdAt: new Date() }, { merge: true }); 
      const categoryRef = userRef.collection("items").doc(Item_Category).collection("clothes");
      await categoryRef.add(itemData);
      console.log("User created and item uploaded in category:", Item_Category);
    }
    
    
    
    
    res.status(200).send("Success");
  } catch (error) {
    console.error("Final upload error:", error);
    res.status(500).json({ error: error.message });
  }
});

exports.AnalyzeImage = onRequest({ cors: true } ,async (req, res) => {
  try {
    const uid = await checkAuth(req); 
    const busboy = Busboy({ headers: req.headers });
    let filePath = "";
    let fileName = "";
    
    busboy.on("file", (fieldname, file, info) => {
      fileName = info.filename;

      filePath = path.join(os.tmpdir(), fileName);
      const writeStream = fs.createWriteStream(filePath);
      file.pipe(writeStream);
    });

    busboy.on("finish", async () => {

      await bucket.upload(filePath, {
        destination: `temp/${uid}/${fileName}`,
        metadata: { contentType: "image/jpeg" }
      });
      

      const tempFileUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/temp%2F${uid}%2F${encodeURIComponent(fileName)}?alt=media`;
      

      const openRouterApi = process.env.openRouterApi2
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${openRouterApi}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          "model": "google/gemini-2.0-flash-001",
          "messages": [
            {
              "role": "user",
              "content": [
                {
                  "type": "text",
                  "text": "Analyze the photo and classify the clothing item. Return only valid JSON in this format: {\"type\": \"[main category from list]\", \"subtype\": \"[specific item type]\", \"color\": \"[Black, White, Gray, Red, Blue, Green, Yellow, Orange, Purple, Pink, Brown, Beige]\", \"outfit_Style\": \"[Sporty, Casual, Official]\"}. Ensure the subtype matches its parent type according to these rules: T-shirt→[Oversized T-shirt, Polo Shirt, Henley]; Shirt→[Classic Dress Shirt, Casual Button-Up Shirt, Flannel Shirt]; Top→[Tank Top, Blouse, Crop Top, Camisole]; Sweater→[Pullover Hoodie, Zip-Up Hoodie, Turtleneck Sweater, Sweater, Zip Sweater]; Jacket→[Leather Jacket, Denim Jacket, Puffer, Windbreaker, Fleece Jacket, Vest, Blazer]; Trousers→[Jeans, Dress Pants, Cargo Pants, Joggers]; Shorts→[Denim Shorts, Chino Shorts, Athletic Shorts]; Skirt→[Skirt, Mini Skirt, Denim Skirt]; Dress→[Dress]; Boots→[Boots, Chelsea Boots, Ugg Boots]; Classic shoes→[Dress Shoes, Loafers, Pumps, Wedges]; Sports shoes→[Sneakers]; Summer shoes→[Flip-Flops, Ballet Flats]; Headdress→[Bucket Hat, Baseball Cap, Beanie]. If unclear, use null. Focus on the largest item in the image."                  },
                {
                  "type": "image_url",
                  "image_url": {
                    "url": tempFileUrl
                  }
                }
              ]
            }
          ]
        })
      });
      
      if (!response.ok) {
        throw new Error(`OpenRouter API error: ${response.status} ${response.statusText}`);
      }
      
      const data = await response.json();
      const messageObj = data.choices?.[0]?.message;
      if (!messageObj || !messageObj.content) {
        throw new Error("Empty response from AI model.");
      }
      
      let cleanContent = messageObj.content.replace(/^```json\n/, "").replace(/\n```$/, "").trim();
      let jsonResponse;
      try {
        jsonResponse = JSON.parse(cleanContent);
      } catch (error) {
        console.error("Parsing error:", error, "Content received:", cleanContent);
        throw new Error("Failed to parse JSON response. Check AI response format.");
      }
      
     
      res.json({ analysis: jsonResponse, tempFilePath: `temp/${uid}/${fileName}` });
    });

    busboy.end(req.rawBody);
  } catch (error) {
    console.error("Request error:", error);
    res.status(500).json({ error: error.message });
  }
}); 


exports.GenerateOutFitByParam = onRequest({ cors: true }, async (req, res) => {
  try {
    const uid = await checkAuth(req);
    const { city, outfit_Style, color_Pallete } = req.body;

    if (!city || !color_Pallete || !outfit_Style) {
      return res.status(400).json({ status: "error", message: "Missing required fields" });
    }

    const weather_data = await getWeather(city);
    const outFitArr = [];
    

    const itemsCache = {};

    async function getDataAndResAI(category, prompt, outfit_Style) {

      if (!itemsCache[category]) {
        itemsCache[category] = await getItemsFromFolder(uid, category);
      }
      
      let dbResponse = itemsCache[category];
      
      if (!dbResponse || dbResponse.length === 0) {
        console.warn(`No items found in category: ${category}`);
        return; 
      }


      let filteredItems = dbResponse.filter(item =>
        item.outfit_Style_Priority && item.outfit_Style_Priority[outfit_Style] !== undefined
      );

      if (filteredItems.length === 0) {
        filteredItems = dbResponse.sort((a, b) => {
          let priorityA = a.outfit_Style_Priority ? (a.outfit_Style_Priority[outfit_Style] || 99) : 99;
          let priorityB = b.outfit_Style_Priority ? (b.outfit_Style_Priority[outfit_Style] || 99) : 99;
          return priorityA - priorityB; 
        });
      }


      let bestMatches = filteredItems.filter(item => 
        item.outfit_Style_Priority && 
        item.outfit_Style_Priority[outfit_Style] === 1
      );
      
      if (bestMatches.length < 5) {
        let priority2Items = filteredItems.filter(item => 
          item.outfit_Style_Priority && 
          item.outfit_Style_Priority[outfit_Style] === 2
        );
        

        if (priority2Items.length > 0) {
          let needed = Math.min(5 - bestMatches.length, priority2Items.length);
          bestMatches.push(...priority2Items.slice(0, needed));
        }
        
        if (bestMatches.length < 5) {
          let additionalItems = filteredItems
            .filter(item => {

              const itemId = item.id;
              return !bestMatches.some(match => match.id === itemId);
            })
            .sort((a, b) => {
              let priorityA = a.outfit_Style_Priority ? (a.outfit_Style_Priority[outfit_Style] || 99) : 99;
              let priorityB = b.outfit_Style_Priority ? (b.outfit_Style_Priority[outfit_Style] || 99) : 99;
              return priorityA - priorityB;
            })
            .slice(0, 5 - bestMatches.length);
          
          bestMatches.push(...additionalItems);
        }
      }
      
      bestMatches = bestMatches.slice(0, 5);
      
      let aiResponse = await AIAnalyzeOutFit(prompt, bestMatches); 
      if (aiResponse) outFitArr.push(aiResponse);
    }

    const temperatureThreshold = 15;
    let categoryMain = weather_data.temperature < temperatureThreshold ? "HeavyWeightMainItem" : "LightWeightMainItem";

    const promptMain = `Select one random object from the following list, IMPORTANT: Return ONLY the JSON object with no explanations or additional text. Example output: {"id":"string","imageUrl":"string","type":"string","subtype":"string","color":"string","outfit_Style":"string","name":"string"}. Include the following conditions: Weather data: Temperature: ${weather_data.temperature}°C, Description: ${weather_data.description}. Color Palette: ${color_Pallete}. Outfit Style: ${outfit_Style}. Ensure that the selected item matches these conditions as closely as possible.`;    
    await getDataAndResAI(categoryMain, promptMain, outfit_Style);

    if (outFitArr.length === 0) {
      return res.status(404).json({ status: "error", message: "No matching outfit found." });
    }

    let categorySecond = weather_data.temperature < temperatureThreshold ? "HeavyWeightSecondItem" : "LightWeightSecondItem";
    
    const promptSecond = `Select one object from the following list that has the best style combination with the following item: ${JSON.stringify(outFitArr[0])}. IMPORTANT: Return ONLY the JSON object with no explanations or additional text. The selected item should either match the style closely or, if it has a completely different color or stylistic approach, it should still complement the first item well (i.e., like a "sandwich" style, where contrasting elements balance each other). The selected item must not be the same as the following: ${JSON.stringify(outFitArr)}. Example output: {"id":"string","imageUrl":"string","type":"string","subtype":"string","color":"string","outfit_Style":"string","name":"string"}.`;  
    await getDataAndResAI(categorySecond, promptSecond, outfit_Style);

    if (outFitArr.length === 1) {
      return res.status(404).json({ status: "error", message: "Only one matching item found, outfit incomplete." });
    }

    const categoryThird = "ThirdItem";
    const promptThird = `Select one object from the following list. IMPORTANT: Return ONLY the JSON object with no explanations or additional text. The selected item must either match the exact color of the first element from the following outfit array: ${JSON.stringify(outFitArr)} or be the best possible match in terms of style, even if the color is different. The item should complement the overall outfit as much as possible and must not be already included in the outfit array: ${JSON.stringify(outFitArr)}. Example output: {"id":"string","imageUrl":"string","type":"string","subtype":"string","color":"string","outfit_Style":"string","name":"string"}.`;    
    await getDataAndResAI(categoryThird, promptThird, outfit_Style);



    res.json(outFitArr);

  } catch (error) {
    console.error("Final upload error:", error);
    res.status(500).json({ error: error.message });
  }
});

exports.GenerateOutFitByMainItem = onRequest({ cors: true }, async (req, res) => {
  try {
    const uid = await checkAuth(req);

    const { itemId } = req.body;
    if (!itemId) {
      return res.status(400).json({ error: "Missing itemId" });
    }

    const userDoc = await colRef.doc(uid).get();
    if (!userDoc.exists) {
      return res.status(404).json({ error: "User document not found" });
    }

    const categories = ['HeavyWeightMainItem', 'LightWeightMainItem', 'HeavyWeightSecondItem', 'LightWeightSecondItem', 'ThirdItem'];

    const queries = categories.map(category => 
      userDoc.ref.collection("items").doc(category).collection("clothes").doc(itemId).get()
    );
    
    const results = await Promise.all(queries);
    let main_item = null;
    let main_item_category = null;
    
    for (let i = 0; i < results.length; i++) {
      const ItemSnapshot = results[i];
      if (ItemSnapshot.exists) {
        main_item = ItemSnapshot.data();
        main_item_category = categories[i]; 
        break;
      }
    }
    
    if (main_item) {
      main_item.Item_Category = main_item_category;
    }
    if (!main_item) {
      return res.status(404).json({ error: "Item not found in any category" });
    }

    const outFitArr = [];  
    outFitArr.push(main_item); 

    async function getDataAndResAI(category, prompt) {
      const dbResponse = await getItemsFromFolder(uid, category); 
      const aiResponse = await AIAnalyzeOutFit(prompt, dbResponse); 
      outFitArr.push(aiResponse);
    }

    const promptSecond = `Select one object from the following list that has the best style and weather/temperature combination with the following item: ${JSON.stringify(main_item)}. IMPORTANT: Return ONLY the JSON object with no explanations or additional text. The selected item should either match the style closely or, if it has a completely different color or stylistic approach, it should still complement the first item well (i.e., like a "sandwich" style, where contrasting elements balance each other). The selected item must not be the same as the following: ${JSON.stringify(outFitArr)}. Example output: {"id":"string","imageUrl":"string","type":"string","subtype":"string","color":"string","outfit_Style":"string","name":"string"}.`;  
   
    const promptThird = `Select one object from the following list. IMPORTANT: Return ONLY the JSON object with no explanations or additional text. The selected item must either match the exact color of the first element from the following outfit array: ${JSON.stringify(outFitArr)} or be the best possible match in terms of style, even if the color is different. The item should complement the overall outfit as much as possible and match weather/temperature style and must not be already included in the outfit array: ${JSON.stringify(outFitArr)}. Example output: {"id":"string","imageUrl":"string","type":"string","subtype":"string","color":"string","outfit_Style":"string","name":"string"}.`;
   
    let categorySecond, categoryThird; 

    switch (main_item.Item_Category) {
      case "HeavyWeightMainItem":
        categorySecond = "HeavyWeightSecondItem";
        await getDataAndResAI(categorySecond, promptSecond);

        categoryThird = "ThirdItem";
        await getDataAndResAI(categoryThird, promptThird);
        break;

      case "LightWeightMainItem":
        categorySecond = "LightWeightSecondItem";
        await getDataAndResAI(categorySecond, promptSecond);

        categoryThird = "ThirdItem";
        await getDataAndResAI(categoryThird, promptThird);
        break;

      case "HeavyWeightSecondItem":
        categorySecond = "HeavyWeightMainItem";
        await getDataAndResAI(categorySecond, promptSecond);

        categoryThird = "ThirdItem";
        await getDataAndResAI(categoryThird, promptThird);
        break;

      case "LightWeightSecondItem":
        categorySecond = "LightWeightMainItem";
        await getDataAndResAI(categorySecond, promptSecond);

        categoryThird = "ThirdItem";
        await getDataAndResAI(categoryThird, promptThird);
        break;

      case "ThirdItem":
        categorySecond = "HeavyWeightMainItem";
        await getDataAndResAI(categorySecond, promptSecond);

        categoryThird = "HeavyWeightSecondItem";
        await getDataAndResAI(categoryThird, promptThird);
        break;
    
      default:
        return res.status(400).json({ error: "Unknown item category" });
    }

    res.json(outFitArr);

  } catch (error) {
    console.error("Final upload error:", error);
    res.status(500).json({ error: error.message });
  }
});

exports.SaveOutfitSet = onRequest({ cors: true }, async (req, res) => {
  try {
    const uid = await checkAuth(req);
    const { items, setName } = req.body;


    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        status: "error",
        message: "Items array is required and must not be empty"
      });
    }

 
    const db = admin.firestore();
    const setData = {
      name: setName || `Outfit Set ${new Date().toLocaleDateString()}`,
      itemCount: items.length
    };


    const setWithCopies = {
      ...setData,
      items: items,
      addedAt: Timestamp.now()
    };

    const setRef = await db.collection(`users/${uid}/sets`).add(setWithCopies);

    res.json({
      status: "success",
      message: "Outfit set saved successfully",
      setId: setRef.id,
      set: {
        id: setRef.id,
        ...setWithCopies
      }
    });

  } catch (error) {
    console.error("Save outfit set error:", error);
    res.status(500).json({ 
      status: "error",
      message: error.message 
    });
  }
});


exports.GetLatestUserItems = onRequest({ cors: true }, async (req, res) => {
  try {
    const uid = await checkAuth(req);
    const categories = ['HeavyWeightMainItem', 'LightWeightMainItem', 'HeavyWeightSecondItem', 'LightWeightSecondItem', 'ThirdItem'];
    const allowedFields = ["id", "imageUrl", "addedAt"];

    const allItems = (await Promise.all(
      categories.map(async (category) => {
        try {
          const snapshot = await db
            .collection("users")
            .doc(uid)
            .collection("items")
            .doc(category)
            .collection("clothes")
            .orderBy("addedAt", "desc")
            .limit(2) 
            .get();
          
          return snapshot.empty
            ? []
            : snapshot.docs.map(doc => {
              const data = doc.data();
              
              const filteredData = Object.fromEntries(
                Object.entries(data).filter(([key]) => allowedFields.includes(key))
              );

              return { id: doc.id, ...filteredData };
            });

        } catch (error) {
          console.error(`Error getting documents from ${category}:`, error);
          return [];
        }
      })
    )).flat();

    if (!allItems.length) {
      return res.status(404).json({ message: "No items found in any category" });
    }

    res.status(200).json({ items: allItems });
  } catch (error) {
    console.error("Error in GetAllUserItems:", error);
    res.status(500).json({ error: error.message });
  }
});

exports.GetLatestOutfitSets = onRequest({ cors: true }, async (req, res) => {
  try {
    const uid = await checkAuth(req);
    const db = admin.firestore();

    const setsSnapshot = await db.collection(`users/${uid}/sets`)
    .orderBy("addedAt", "desc")
    .limit(5)
    .get();
    if (setsSnapshot.empty) {
      return res.json({ status: "success", message: "No outfit sets found", sets: [] });
    }

    const sets = setsSnapshot.docs.map(setDoc => {
      const setData = setDoc.data();
      return { id: setDoc.id, ...setData, items: setData.items || [] };
    });

    res.json({ status: "success", sets });
  } catch (error) {
    console.error("Get outfit sets error:", error);
    res.status(500).json({ status: "error", message: error.message });
  }
});


exports.GetAllUserItems = onRequest({ cors: true }, async (req, res) => {
  try {
    const uid = await checkAuth(req);
    const categories = ['HeavyWeightMainItem', 'LightWeightMainItem', 'HeavyWeightSecondItem', 'LightWeightSecondItem', 'ThirdItem'];
    const allowedFields = ["id", "imageUrl", "addedAt","name"];

    const allItems = (await Promise.all(
      categories.map(async (category) => {
        try {
          const snapshot = await db
            .collection("users")
            .doc(uid)
            .collection("items")
            .doc(category)
            .collection("clothes")
            .get();
          
            return snapshot.empty
            ? []
            : snapshot.docs.map(doc => {
              const data = doc.data();
              
              const filteredData = Object.fromEntries(
                Object.entries(data).filter(([key]) => allowedFields.includes(key))
              );

              return { id: doc.id, ...filteredData };
            });

        } catch (error) {
          console.error(`Error getting documents from ${category}:`, error);
          return [];
        }
      })
    )).flat();

    if (!allItems.length) {
      return res.status(404).json({ message: "No items found in any category" });
    }

    res.status(200).json({ items: allItems });
  } catch (error) {
    console.error("Error in GetAllUserItems:", error);
    res.status(500).json({ error: error.message });
  }
});

exports.GetAllOutfitSets = onRequest({ cors: true }, async (req, res) => {
  try {
    const uid = await checkAuth(req);
    const db = admin.firestore();

    const setsSnapshot = await db.collection(`users/${uid}/sets`).get();
    if (setsSnapshot.empty) {
      return res.json({ status: "success", message: "No outfit sets found", sets: [] });
    }

    const sets = setsSnapshot.docs.map(setDoc => {
      const setData = setDoc.data();
      return { id: setDoc.id, ...setData, items: setData.items || [] };
    });

    res.json({ status: "success", sets });
  } catch (error) {
    console.error("Get outfit sets error:", error);
    res.status(500).json({ status: "error", message: error.message });
  }
});



exports.GetItem = onRequest({ cors: true }, async (req, res) => {
  try {
    const uid = await checkAuth(req);
    if (!uid) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { itemId } = req.body;
    if (!itemId) {
      return res.status(400).json({ error: "Missing itemId" });
    }

    const userDoc = await colRef.doc(uid).get();
    if (!userDoc.exists) {
      return res.status(404).json({ error: "User document not found" });
    }

    const categories = ['HeavyWeightMainItem', 'LightWeightMainItem', 'HeavyWeightSecondItem', 'LightWeightSecondItem', 'ThirdItem'];

    const queries = categories.map(category => 
      userDoc.ref.collection("items").doc(category).collection("clothes").doc(itemId).get()
    );
    
    const results = await Promise.all(queries);
    
    for (const ItemSnapshot of results) {
      if (ItemSnapshot.exists) {
        return res.status(200).json(ItemSnapshot.data());
      }
    }

    return res.status(404).json({ error: "Item not found" });

  } catch (error) {
    console.error("Error in GetItem:", error);
    res.status(500).json({ error: error.message });
  }
});

exports.UpdateItem = onRequest({ cors: true }, async (req, res) => {
  try {
    const uid = await checkAuth(req);
    if (!uid) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { itemId, name, type, subtype, color, outfit_Style } = req.body;
    
    if (!itemId) {
      return res.status(400).json({ error: "Missing itemId" });
    }

    const userDoc = await colRef.doc(uid).get();
    if (!userDoc.exists) {
      return res.status(404).json({ error: "User document not found" });
    }

    const categories = ['HeavyWeightMainItem', 'LightWeightMainItem', 'HeavyWeightSecondItem', 'LightWeightSecondItem', 'ThirdItem'];

    const queries = categories.map(category => 
      userDoc.ref.collection("items").doc(category).collection("clothes").doc(itemId).get()
    );
    
    const results = await Promise.all(queries);
    
    for (const ItemSnapshot of results) {
      if (ItemSnapshot.exists) {
        const itemRef = ItemSnapshot.ref;

        let updateData = {};
        if (name !== undefined) updateData.name = name;
        if (type !== undefined) updateData.type = type;
        if (subtype !== undefined) updateData.subtype = subtype;
        if (color !== undefined) updateData.color = color;
        if (outfit_Style !== undefined) updateData.outfit_Style = outfit_Style;

        if (Object.keys(updateData).length === 0) {
          return res.status(400).json({ error: "No valid fields to update" });
        }

        await itemRef.update(updateData);

        return res.status(200).json({ success: true, message: "Item updated successfully" });

      }
    }

    return res.status(404).json({ error: "Item not found" });

  } catch (error) {
    console.error("Error in UpdateItem:", error);
    res.status(500).json({ error: error.message });
  }
});

exports.RemoveItem = onRequest({ cors: true }, async (req, res) => {
  try {
    const uid = await checkAuth(req);
    if (!uid) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { itemId } = req.body;
    if (!itemId) {
      return res.status(400).json({ error: "Missing itemId" });
    }

    const userDoc = await colRef.doc(uid).get();
    if (!userDoc.exists) {
      return res.status(404).json({ error: "User document not found" });
    }

    const categories = ['HeavyWeightMainItem', 'LightWeightMainItem', 'HeavyWeightSecondItem', 'LightWeightSecondItem', 'ThirdItem'];
    const storage = getStorage();
    let itemFound = false;

    for (const category of categories) {
      const itemRef = userDoc.ref.collection("items").doc(category).collection("clothes").doc(itemId);
      const itemSnapshot = await itemRef.get();

      if (itemSnapshot.exists) {
        itemFound = true;
        const itemData = itemSnapshot.data();
        
        await itemRef.delete();

        if (itemData.imageUrl) {
          const imagePath = decodeURIComponent(itemData.imageUrl.split("/o/")[1].split("?")[0]);
          await storage.bucket().file(imagePath).delete();
          console.log(`Image deleted: ${imagePath}`);
        }

        break; 
      }
    }

    if (itemFound) {
      return res.status(200).json({ message: "Item and image deleted successfully" });
    } else {
      return res.status(404).json({ error: "Item not found" });
    }

  } catch (error) {
    console.error("Error in RemoveItem:", error);
    res.status(500).json({ error: error.message });
  }
});



exports.GetOufit = onRequest({ cors: true }, async (req, res) => {
  try {
    const uid = await checkAuth(req);
    if (!uid) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { OutfitId } = req.body;
    if (!OutfitId) {
      return res.status(400).json({ error: "Missing OutfitId" });
    }

    const userDoc = await colRef.doc(uid).get();
    if (!userDoc.exists) {
      return res.status(404).json({ error: "User document not found" });
    }
    const OutfitSnapshot = await userDoc.ref.collection("sets").doc(OutfitId).get();
    let resArray = [];

    if (!OutfitSnapshot.exists) {
      return res.status(404).json({ error: "Outfit not found" });
    }

    resArray.push(OutfitSnapshot._fieldsProto.name);

    if (OutfitSnapshot._fieldsProto.items && OutfitSnapshot._fieldsProto.items.arrayValue && OutfitSnapshot._fieldsProto.items.arrayValue.values) {
      OutfitSnapshot._fieldsProto.items.arrayValue.values.forEach(item => {
        resArray.push(item.mapValue.fields);
      });
    }

    const filePath = `prewiu/${uid}/${OutfitId}`;
    const [files] = await bucket.getFiles({ prefix: filePath });

    if (files.length) {
      const file = files[0];
      const [url] = await file.getSignedUrl({
        action: 'read',
        expires: Date.now() + 60 * 60 * 1000,
      });
      resArray.push({ previewUrl: url }); 
    }

    return res.status(200).json(resArray);

  } catch (error) {
    console.error("Error in GetItem:", error);
    res.status(500).json({ error: error.message });
  }
});

exports.AddItemToOutfit = onRequest({ cors: true }, async (req, res) => {
  try {
    const uid = await checkAuth(req);
    if (!uid) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { OutfitId, itemId } = req.body;
    if (!OutfitId || !itemId) {
      return res.status(400).json({ error: "Missing OutfitId" });
    }

    const userDoc = await colRef.doc(uid).get();
    if (!userDoc.exists) {
      return res.status(404).json({ error: "User document not found" });
    }

    const categories = ['HeavyWeightMainItem', 'LightWeightMainItem', 'HeavyWeightSecondItem', 'LightWeightSecondItem', 'ThirdItem'];

    const queries = categories.map(category => 
      userDoc.ref.collection("items").doc(category).collection("clothes").doc(itemId).get()
    );
    
    const results = await Promise.all(queries);
    let itemData

    for (const ItemSnapshot of results) {
      if (ItemSnapshot.exists) {
        itemData = ItemSnapshot.data()
      }
    } 

    await db.collection(`users/${uid}/sets`).doc(OutfitId).update({
      items: FieldValue.arrayUnion(itemData),
    });

    return res.status(200).json({ success: true, message: "Item added successfully" });

  } catch (error) {
    console.error("Error in GetItem:", error);
    res.status(500).json({ error: error.message });
  }
});

exports.RemoveOutfit = onRequest({ cors: true }, async (req, res) => {
  try {
    const uid = await checkAuth(req);
    if (!uid) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { OutfitId } = req.body;
    if (!OutfitId) {
      return res.status(400).json({ error: "Missing OutfitId" });
    }

    const userDoc = await colRef.doc(uid).get();
    if (!userDoc.exists) {
      return res.status(404).json({ error: "User document not found" });
    }

    const OutfitRef = userDoc.ref.collection('sets').doc(OutfitId);
    
    const outfitDoc = await OutfitRef.get();
    if (!outfitDoc.exists) {
      return res.status(404).json({ error: "Outfit not found" });
    }

    await OutfitRef.delete();
    return res.status(200).json({ message: "Outfit deleted successfully" });

  } catch (error) {
    console.error("Error in RemoveOutfit:", error);
    res.status(500).json({ error: error.message });
  }
});

exports.RemoveItemInOutfit = onRequest({ cors: true }, async (req, res) => {
  try {
    const uid = await checkAuth(req);

    if (!uid) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { OutfitId, name } = req.body;
    if (!OutfitId || !name) {
      return res.status(400).json({ error: "Missing OutfitId or name" });
    }

    const docRef = db.collection(`users/${uid}/sets`).doc(OutfitId);
    const docSnap = await docRef.get();

    if (!docSnap.exists) {
      return res.status(404).json({ error: "Outfit not found" });
    }

    const data = docSnap.data();
    const items = data.items || [];

    
    const updatedItems = items.filter(item => item.name !== name);

    await docRef.update({
      items: updatedItems
    });

    return res.status(200).json({ message: "Item removed successfully" });

  } catch (error) {
    console.error("Error in RemoveItemInOutfit:", error);
    res.status(500).json({ error: error.message });
  }
});

exports.AddPrewiuToOutfit = onRequest({ cors: true }, async (req, res) => {
  try {
    const uid = await checkAuth(req);
    if (!uid) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    let OutfitId = "";
    let filePath = "";
    let fileName = "";

    const busboy = Busboy({ headers: req.headers });

    busboy.on("field", (fieldname, value) => {
      if (fieldname === "OutfitId") {
        OutfitId = value;
      }
    });

    busboy.on("file", (fieldname, file, info) => {
      fileName = info.filename;
      filePath = path.join(os.tmpdir(), fileName);
      const writeStream = fs.createWriteStream(filePath);
      file.pipe(writeStream);
    });

    busboy.on("finish", async () => {
      if (!OutfitId) {
        return res.status(400).json({ error: "Missing OutfitId" });
      }

      await bucket.upload(filePath, {
        destination: `prewiu/${uid}/${OutfitId}/${fileName}`,
        metadata: { contentType: "image/jpeg" }
      });

      return res.status(200).json({ success: true, message: "Preview uploaded successfully" });
    });

    busboy.end(req.rawBody);

  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Internal server error" });
  }
});
