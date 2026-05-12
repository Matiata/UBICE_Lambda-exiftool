import { createRequire } from "module";
const require = createRequire(import.meta.url);
const fs = require("fs");
const _ = require("lodash"); // full lodash module
import { execSync, execFileSync } from "child_process";

process.env.LD_LIBRARY_PATH = "/opt/lib64:" + (process.env.LD_LIBRARY_PATH || "");
process.env.PERL5LIB = "/opt/perl/lib/5.42.0:/opt/perl/lib/site_perl/5.42.0";
process.env.LC_ALL = "C";
process.env.LANG = "C";
const OK_DATA_TYPE_VIDEO = "VIDEO";
const OK_DATA_TYPE_PHOTO = "PHOTO";
const AWS = require("aws-sdk");
const s3SA = new AWS.S3({ region: "sa-east-1" });
const s3US = new AWS.S3({ region: "us-west-2" });
const rekognitionClient = new AWS.Rekognition({ region: "us-west-2" });

async function writeMetadataOnImage(imagePath, numbers) {
  let finalTags = Array.from(new Set(numbers.map((value) => String(value).trim()).filter(Boolean)));
  let originalTags = [];

  try {
    const originalMetadataRaw = execFileSync("exiftool", ["-j", "-keywords", imagePath], {
      encoding: "utf8",
    });
    const parsedMetadata = JSON.parse(originalMetadataRaw)?.[0] ?? {};
    if (Array.isArray(parsedMetadata.Keywords)) {
      originalTags = parsedMetadata.Keywords;
    } else if (typeof parsedMetadata.Keywords === "string") {
      originalTags = parsedMetadata.Keywords
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
    }
    console.log("originalTags:", originalTags);
  } catch (err) {
    console.warn("Could not read existing exif keywords:", err?.message ?? err);
  }

  for (const tag of originalTags) {
    if (!finalTags.includes(tag)) {
      finalTags.push(tag);
    }
  }

  if (!finalTags.length) {
    finalTags = ["#"];
  } else {
    finalTags = finalTags.map((number) => {
      return (number === "#" || !Number.isInteger(number))
        ? String(number)
        : _.padStart(String(number), 5, "0");
    });
  }
  console.log("finalTags:", finalTags);

  try {
    const writeOutput = execFileSync("exiftool", [
      `-keywords=${finalTags.join(",")}`,
      "-overwrite_original",
      imagePath,
    ], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    console.log("exiftool write output:", writeOutput.trim() || "(empty stdout)");
  } catch (err) {
    const stderr = err?.stderr?.toString?.("utf8") ?? "";
    const stdout = err?.stdout?.toString?.("utf8") ?? "";
    console.error("Exiftool write failed", {
      imagePath,
      message: err?.message,
      stdout,
      stderr,
    });
    throw err;
  }

  const verifyRaw = execFileSync("exiftool", ["-j", "-keywords", imagePath], {
    encoding: "utf8",
  });
  console.log("exiftool keywords after write:", verifyRaw);
  return finalTags;
}

const useRegex = (input) => {
  let regex = /^[0-9]+$/i;
  return regex.test(input);
};

async function deleteObjectFromS3(bucketName, objectKey) {
  try {
    await s3SA
      .deleteObject({
        Bucket: bucketName,
        Key: objectKey,
      })
      .promise();
    console.log(`Deleted object ${objectKey} from bucket ${bucketName}`);
  } catch (err) {
    console.error(
      `Error deleting object ${objectKey} from bucket ${bucketName}: `,
      err
    );
  }
}

async function rekognize(imageBytes, bannedNumbers) {
  try {
    const params = {
      Image: {
        Bytes: imageBytes,
      },
      Filters: {
        WordFilter: {
          MinConfidence: 95,
        },
      },
    };
    const commandResult = await rekognitionClient.detectText(params).promise();
    let numbersArray = commandResult.TextDetections.filter((textDetection) =>
      useRegex(textDetection.DetectedText)
    ).map((textDetection) => textDetection.DetectedText);
    // Remove duplicated numbers as well as the banned numbers from the result
    numbersArray = Array.from(new Set(numbersArray));
    numbersArray = numbersArray.map(Number);
    numbersArray = numbersArray.filter(
      (number) => !bannedNumbers.includes(number)
    );
    // Format numbers accordingly for labeling that meets photomechanic criteria
    if (!numbersArray.length) {
      numbersArray = ["#"];
    } else {
      numbersArray = numbersArray.map((number) =>
        _.padStart(String(number), 5, "0")
      );
    }
    return numbersArray;
  } catch (err) {
    console.error("Error rekognizing an image: ", err);
    return ["#"]; // Return default tag on error
  }
}

/*
 * objectKey is like this: publicImages/_public/bannedNumbers-2003_2004/evento_11/foto_b3b37d95-546a-41c0-bccb-bb2b4cf0303c
 * We want to save it in the upload bucket as evento_11/foto_b3b37d95-546a-41c0-bccb-bb2b4cf0303c
 */

function extractBannedNumbers(objectKey) {
  const parts = objectKey.split("/");
  let bannedNumbersString = parts[2];
  // Remove the prefix "bannedNumbers="
  const prefix = "bannedNumbers-";
  const numbersPart = bannedNumbersString.replace(prefix, "");

  // Split the remaining string by underscores
  const numberStrings = numbersPart.split("_");

  // Convert to numbers and filter out any empty strings
  const numbersArray = numberStrings
    .filter((numStr) => numStr !== "")
    .map((numStr) => parseInt(numStr, 10));

  return numbersArray;
}

// objectKey: publicImages/_public/bannedNumbers-xxx_yyy/evento_xxx/fotoXXX.jpg
function getFilename(objectKey) {
  const parts = objectKey?.split("/") ?? [];
  return parts[parts.length - 1] ?? null;
}

function getEvent(objectKey) {
  const parts = objectKey?.split("/") ?? [];
  for (const part of parts) {
    const match = part.match(/evento[_-](\d+)/i);
    if (match?.[1]) {
      return match[1];
    }
  }
  return null;
}

async function notifyUbice(photos) {
  // Here we notify Ubice with photos that already exists in the download bucket, so we do it one by one
  const results = [];
  for (const photo of photos) {
    try {
      const res = await fetch(process.env.NOTIFICATION_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ 'event': photo.event, 'filename': photo.filename, 'key': photo.key }),
      });
      console.log("Notification sent: ", res.status);
      results.push({
        event: photo.event,
        filename: photo.filename,
        key: photo.key,
        status: res.status,
        error: res.status === 200 ? null : res.statusText
      });
    } catch (err) {
      console.error("Error notifying Ubice for photo:", photo, err);
      results.push({
        event: photo.event,
        filename: photo.filename,
        key: photo.key,
        status: 'error',
        error: err.message
      });
    }
  }
  return results;
}

async function processImage(objectKey, eventID, filename, ph) {
  const fname = ph ? ph + '_' + filename : filename;
  const downloadKey = 'evento_' + eventID + '/' + fname;
  console.log("Processing image: ", { objectKey, eventID, fname, downloadKey });
  try {
    // Get the uploaded photo
    const response = await s3SA
      .getObject({ Bucket: process.env.UPLOAD_BUCKET_NAME, Key: objectKey })
      .promise();

    // Check if photo already exists
    const photoExistsResponse = await s3US.listObjectsV2({
      Bucket: process.env.DESTINATION_BUCKET_NAME,
      Prefix: downloadKey
    }).promise();

    console.log("photoExistsResponse:", photoExistsResponse.Contents?.length === 0 ? "New photo" : "Photo already exists");

    if (photoExistsResponse.Contents?.length === 0) {
      // Process new photo
      const bannedNumbers = extractBannedNumbers(objectKey);
      console.log("Banned numbers: ", bannedNumbers);

      const numbersArray = await rekognize(response.Body, bannedNumbers);
      console.log("Obtained numbers: ", numbersArray);

      const imageFilePath = "/tmp/" + fname;

      // Write metadata
      fs.writeFileSync(imageFilePath, response.Body);
      console.log("Writing tags on the image");
      const finalTags = await writeMetadataOnImage(imageFilePath, numbersArray);

      // Read the processed image for batch upload
      const taggedBytes = fs.readFileSync(imageFilePath);
      // fs.unlinkSync(imageFilePath);
      const metadataRaw = execFileSync("exiftool", ["-j", "-all", imageFilePath], {
        encoding: "utf8",
      });
      let metadata = {};
      try {
        metadata = JSON.parse(metadataRaw)?.[0] ?? {};
      } catch (err) {
        console.warn("Could not parse exiftool metadata JSON:", err?.message ?? err);
      }
      const description =
        metadata.Description ??
        metadata.ImageDescription ??
        metadata["Caption-Abstract"] ??
        metadata.Headline ??
        null;
      const dateTime =
        metadata.DateTimeOriginal ??
        metadata.DateCreated ??
        metadata.CreateDate ??
        metadata.ModifyDate ??
        null;
      console.log("exiftool metadata before upload:", {
        description,
        dateTime,
        keywords: metadata.Keywords ?? null,
      });
      // Clean up uploaded file
      // await deleteObjectFromS3(process.env.UPLOAD_BUCKET_NAME, objectKey);

      return {
        event: eventID,
        filename: fname,
        key: downloadKey,
        status: 'processed',
        shouldNotify: false,
        imageData: {
          filePath: imageFilePath,
          key: downloadKey,
          body: taggedBytes,
          keywords: finalTags,
          description: description,
          dateTime: dateTime,
          contentType: response.ContentType ?? "image/jpeg"
        }
      };
    } else {
      console.log('Photo already exists, skipping processing');
      // Clean up uploaded file
      await deleteObjectFromS3(process.env.UPLOAD_BUCKET_NAME, objectKey);
      return {
        event: eventID,
        filename: fname,
        key: downloadKey,
        status: 'skipped',
        shouldNotify: true
      };
    }

  } catch (err) {
    console.error("Error processing image:", err, { objectKey, eventID, filename });
    return {
      event: eventID,
      filename: fname,
      key: downloadKey,
      status: 'error',
      error: err.message,
      shouldNotify: false
    };
  }
}

async function batchUploadToDestination(imagesToUpload) {
  const uploadPromises = imagesToUpload.map(async (imageData) => {
    try {
      console.log("imageData before upload:", { imageData });
      await s3US.putObject({
        Bucket: process.env.DESTINATION_BUCKET_NAME,
        Key: imageData.key,
        Body: imageData.body,
        ContentType: imageData.contentType,
      }).promise();

      console.log(`Uploaded image ${imageData.key} to destination bucket`);
      return { key: imageData.key, status: 'success' };
    } catch (err) {
      console.error(`Error uploading image ${imageData.key}:`, err);
      return { key: imageData.key, status: 'error', error: err.message };
    } finally {
      fs.unlinkSync(imageData.filePath);
    }
  });

  return await Promise.all(uploadPromises);
}

async function uploadOkFile(uploadResults, eventID, imagesData) {
  // Filter only successful uploads
  const successfulKeys = uploadResults
    .filter(result => result.status === 'success')
    .map(result => result.key);
  if (successfulKeys.length === 0) return null;
  let okContent = "";
  for (const key of successfulKeys) {
    const imageData = imagesData.find(imageData => imageData.key === key);
    okContent += `${key};keywords:${imageData.keywords.join(',')};description:${imageData.description};dateTime:${imageData.dateTime}\n`;
  }
  // Create .ok file content (one key per line)
  // Name the .ok file with a timestamp
  const okFileName = `batch_${Date.now()}.ok`;

  try {
    const uploadPrefix = `/evento_` + eventID + `/`;
    await s3US.putObject({
      Bucket: process.env.DESTINATION_BUCKET_NAME,
      Key: `${uploadPrefix}${okFileName}`,
      Body: okContent,
      ContentType: 'text/plain',
    }).promise();
    console.log(`Uploaded .ok file: ${okFileName}`);
    return okFileName;
  } catch (err) {
    console.error('Error uploading .ok file:', err);
    return null;
  }
}

// objectKey: publicImages/_public/bannedNumbers-xxx_yyy/evento_xxx/fotoXXX.jpg
async function cleanUploadBucket(uploadResults, okFileKey) {
  const pathPrefix = okFileKey?.split('/') ?? [];
  const bannedPrefix = pathPrefix[pathPrefix.length - 3] ?? 'bannedNumbers-';

  const deletePromises = uploadResults.map(result => {
    if (result.status === 'success') {
      const fileKey = `publicImages/_public/${bannedPrefix}/${result.key}`;
      return deleteObjectFromS3(process.env.UPLOAD_BUCKET_NAME, fileKey);
    }
    return Promise.resolve(); // Skip deletion for errors
  });
  await Promise.all(deletePromises);
  // Also delete the .ok file
  if (okFileKey) {
    await deleteObjectFromS3(process.env.UPLOAD_BUCKET_NAME, okFileKey);
  }
  console.log('Cleaned up upload bucket');
}

function parseManifestDataType(line) {
  const cleanLine = line.trim();
  if (!cleanLine.startsWith("DATA_TYPE:")) {
    return null;
  }
  const dataType = cleanLine.replace("DATA_TYPE:", "").trim().toUpperCase();
  if (dataType === OK_DATA_TYPE_VIDEO || dataType === OK_DATA_TYPE_PHOTO) {
    return dataType;
  }
  return null;
}


// Download and parse the .ok file
async function downloadAndParseOkFile(s3Client, bucketName, objectKey) {
  const itemKeys = [];
  let photographer = null;
  let dataType = null;
  let firstNonEmptyLineSeen = false;
  try {
    const okFile = await s3Client.getObject({
      Bucket: bucketName,
      Key: objectKey,
    }).promise();
    const okFileContent = okFile.Body.toString('utf-8');
    // Parse keys from the .ok file (one per line)
    let lines = okFileContent.split('\n').map(line => line.trim()).filter(Boolean);
    for (const line of lines) {
      const cleanLine = line.trim();
      if (!cleanLine) {
        continue;
      }
      if (!firstNonEmptyLineSeen) {
        firstNonEmptyLineSeen = true;
        const firstLineType = parseManifestDataType(cleanLine);
        if (firstLineType) {
          dataType = firstLineType;
          continue;
        }
      }
      if (cleanLine.startsWith("PHOTOGRAPHER:")) {
        photographer = cleanLine.replace("PHOTOGRAPHER:", "").trim();
        continue;
      }
      itemKeys.push(cleanLine);
    }
  } catch (err) {
    console.error('Error downloading .ok file:', err);
    throw err;
  }
  return [itemKeys, photographer, dataType];
}

export const handler = async (event) => {
  const record = event.Records[0];
  const objectKey = record.s3.object.key;
  if (!objectKey.endsWith('.ok')) {
    return { statusCode: 200, body: 'Not a .ok file, skipping.' };
  }

  let imageKeys;
  let ph;
  try {
    [imageKeys, ph] = await downloadAndParseOkFile(s3SA, process.env.UPLOAD_BUCKET_NAME, objectKey);
  } catch (err) {
    return { statusCode: 500, body: 'Error downloading .ok file. ' + objectKey };
  }

  const results = [];
  const existingPhotos = [];
  const imagesToUpload = [];
  let eventID = null;
  for (const imageKey of imageKeys) {
    console.log("Processing image: ", imageKey);
    eventID = getEvent(imageKey);
    const filename = getFilename(imageKey);
    try {
      const result = await processImage(imageKey, eventID, filename, ph);
      results.push(result);
      if (result.shouldNotify) {
        existingPhotos.push(result);
      } else if (result.status === 'processed') {
        imagesToUpload.push(result.imageData);
      }
    } catch (err) {
      console.error('Error processing image:', err, { imageKey });
      results.push({ imageKey, status: 'error', error: err.message });
    }
  }

  const uploadResults = await batchUploadToDestination(imagesToUpload);
  const okFile = await uploadOkFile(uploadResults, eventID, imagesToUpload);
  console.log("OK file uploaded: ", okFile);
  await cleanUploadBucket(uploadResults, objectKey);
  const notifyResults = await notifyUbice(existingPhotos);
  console.log("Notification results: ", notifyResults);

  console.log("Batch processing results: ", results);

  return {
    statusCode: 200,
    body: JSON.stringify({
      message: 'Batch processed'
    }),
  };
};