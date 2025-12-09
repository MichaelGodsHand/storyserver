/**
 * DeepShare - Story Protocol IP Registration Server
 * Registers captured images with depth metadata as IP assets
 */

const express = require('express');
const { StoryClient, PILFlavor, WIP_TOKEN_ADDRESS } = require('@story-protocol/core-sdk');
const { http, parseEther, zeroAddress } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const { createHash } = require('crypto');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(express.json());

// Configuration (from .env file)
const PORT = process.env.PORT || 3003;
const RPC_URL = process.env.RPC_URL || "https://aeneid.storyrpc.io";
const CHAIN_ID = process.env.CHAIN_ID || "aeneid";

// Server's private key for Story Protocol transactions
const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) {
    console.error('❌ ERROR: PRIVATE_KEY not found in .env file!');
    console.error('   Add PRIVATE_KEY=your_key_here to .env');
    process.exit(1);
}

// IPFS Gateway for fetching metadata (Pinata gateway)
const IPFS_GATEWAY = process.env.IPFS_GATEWAY || "https://gateway.pinata.cloud";

// Pinata credentials for uploading metadata
const PINATA_API_KEY = process.env.PINATA_API_KEY || "0ff2ea6684694884ba5e";
const PINATA_SECRET_KEY = process.env.PINATA_SECRET_KEY || "2ca0f5efa68114d777c1439af366d408c9c9091777e6d9f229fa46d516c1a213";

// Supabase configuration for storing IP registration data
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

console.log('\n🔍 Checking Supabase Configuration...');
if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.warn('❌ WARNING: Supabase credentials NOT found in .env');
    console.warn('   IP registration will work, but data won\'t be saved to database');
    console.warn('   Add these to story-server/.env:');
    console.warn('   SUPABASE_URL=https://your-project.supabase.co');
    console.warn('   SUPABASE_SERVICE_ROLE_KEY=your_key_here\n');
} else {
    console.log('✅ Supabase credentials loaded');
    console.log(`   URL: ${SUPABASE_URL}`);
    console.log(`   Key: ${SUPABASE_KEY.substring(0, 20)}...`);
    
    // Check which key is being used
    const isServiceRole = process.env.SUPABASE_SERVICE_ROLE_KEY ? true : false;
    if (!isServiceRole) {
        console.warn('⚠️  WARNING: Using SUPABASE_ANON_KEY instead of SERVICE_ROLE_KEY');
        console.warn('   This may cause RLS policy issues with updates.');
        console.warn('   Recommended: Use SUPABASE_SERVICE_ROLE_KEY for server operations.');
    } else {
        console.log('✅ Using SERVICE_ROLE_KEY (bypasses RLS)');
    }
}

// Ensure private key has 0x prefix
const formattedPrivateKey = PRIVATE_KEY.startsWith('0x') ? PRIVATE_KEY : `0x${PRIVATE_KEY}`;

// Default values (can be overridden per request)
const DEFAULT_MINTING_FEE = process.env.DEFAULT_MINTING_FEE || "0.1";
const DEFAULT_COMMERCIAL_REV_SHARE = parseInt(process.env.DEFAULT_COMMERCIAL_REV_SHARE || "10");

// Initialize Story Protocol client once with server's key
let storyClient = null;
let spgNftContract = null;
let serverWalletAddress = null;

// Initialize client on startup
try {
    const account = privateKeyToAccount(formattedPrivateKey);
    serverWalletAddress = account.address;
    
    storyClient = StoryClient.newClient({
        account,
        transport: http(RPC_URL),
        chainId: CHAIN_ID,
    });
    
    console.log(`✅ Story Protocol client initialized`);
    console.log(`   Server Wallet: ${serverWalletAddress}`);
} catch (error) {
    console.error('❌ Failed to initialize Story Protocol client:', error.message);
    process.exit(1);
}

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'DeepShare IP Registration' });
});

// Helper function to fetch metadata from IPFS
async function fetchFromIPFS(cid) {
    const url = `${IPFS_GATEWAY}/ipfs/${cid}`;
    
    try {
        const response = await axios.get(url, { timeout: 30000 });
        return response.data;
    } catch (error) {
        console.error(`   ✗ Failed to fetch from IPFS: ${error.message}`);
        throw new Error(`Failed to fetch CID ${cid} from IPFS: ${error.message}`);
    }
}

// Helper function to upload JSON to Pinata
async function uploadJSONToIPFS(jsonData) {
    console.log('   Uploading JSON to Pinata...');
    
    const url = 'https://api.pinata.cloud/pinning/pinJSONToIPFS';
    
    try {
        const response = await axios.post(url, jsonData, {
            headers: {
                'Content-Type': 'application/json',
                'pinata_api_key': PINATA_API_KEY,
                'pinata_secret_api_key': PINATA_SECRET_KEY,
            },
        });
        
        const ipfsHash = response.data.IpfsHash;
        console.log(`   ✓ Uploaded to IPFS: ${ipfsHash}`);
        
        return ipfsHash;
    } catch (error) {
        console.error('   ✗ Pinata upload failed:', error.message);
        throw new Error(`Failed to upload JSON to IPFS: ${error.message}`);
    }
}

// Helper function to update Supabase with IP registration data
async function updateSupabaseWithIPData(imageCid, ipUrl, txHash) {
    if (!SUPABASE_URL || !SUPABASE_KEY) {
        console.log('   ⚠️  Skipping Supabase update (credentials not configured)');
        return null;
    }

    console.log(`\n📊 Updating Supabase database...`);
    console.log(`   Table: images`);
    console.log(`   Looking for image_cid: ${imageCid}`);
    console.log(`   Will set ip: ${ipUrl}`);
    console.log(`   Will set tx_hash: ${txHash}`);
    
    try {
        const baseUrl = `${SUPABASE_URL}/rest/v1/images`;
        const headers = {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=representation'
        };
        
        // First, check if row exists
        console.log(`   Checking if row exists...`);
        const checkUrl = `${baseUrl}?image_cid=eq.${imageCid}&select=wallet_address,image_cid,metadata_cid`;
        const checkResponse = await axios.get(checkUrl, { headers });
        
        if (!checkResponse.data || checkResponse.data.length === 0) {
            console.error(`   ✗ ERROR: No row found with image_cid = ${imageCid}`);
            console.error(`   Make sure IPFS service created the row first!`);
            return null;
        }
        
        console.log(`   ✓ Found existing row:`, checkResponse.data[0]);
        
        // Update the row
        const updateUrl = `${baseUrl}?image_cid=eq.${imageCid}`;
        const updateData = {
            ip: ipUrl,
            tx_hash: txHash
        };
        
        console.log(`   Sending PATCH request to: ${updateUrl}`);
        console.log(`   Data:`, updateData);
        
        const response = await axios.patch(updateUrl, updateData, { 
            headers,
            timeout: 10000 
        });
        
        console.log(`   Response status: ${response.status}`);
        console.log(`   Response data:`, response.data);
        
        // Verify the update actually worked by fetching the row again
        console.log(`   Verifying update...`);
        const verifyResponse = await axios.get(
            `${baseUrl}?image_cid=eq.${imageCid}&select=image_cid,ip,tx_hash`,
            { headers, timeout: 5000 }
        );
        
        if (verifyResponse.data && verifyResponse.data.length > 0) {
            const row = verifyResponse.data[0];
            console.log(`   Verification result:`, row);
            
            if (row.ip === ipUrl && row.tx_hash === txHash) {
                console.log(`   ✅ CONFIRMED: Data successfully written to Supabase!`);
                return row;
            } else {
                console.error(`   ❌ VERIFICATION FAILED: Data not written!`);
                console.error(`   Expected ip: ${ipUrl}`);
                console.error(`   Got ip: ${row.ip}`);
                console.error(`   Expected tx_hash: ${txHash}`);
                console.error(`   Got tx_hash: ${row.tx_hash}`);
                console.error(`   This might be an RLS (Row Level Security) policy issue.`);
                console.error(`   Make sure your SUPABASE_SERVICE_ROLE_KEY has update permissions.`);
                return null;
            }
        } else {
            console.error(`   ❌ Row disappeared after update! This shouldn't happen.`);
            return null;
        }
    } catch (error) {
        console.error(`   ✗ Failed to update Supabase:`);
        console.error(`   Error: ${error.message}`);
        if (error.response) {
            console.error(`   Status: ${error.response.status}`);
            console.error(`   Response:`, JSON.stringify(error.response.data, null, 2));
        }
        // Don't throw - we don't want Supabase errors to break IP registration
        return null;
    }
}

// Get or create SPG NFT Collection (called once on first registration)
async function getOrCreateCollection() {
    // Check if we already have a collection
    if (spgNftContract) {
        return spgNftContract;
    }

    console.log('\n📦 Creating new SPG NFT Collection for DeepShare...');
    
    const newCollection = await storyClient.nftClient.createNFTCollection({
        name: 'DeepShare Evidence Collection',
        symbol: 'DEEPSHARE',
        isPublicMinting: false, // Only server can mint
        mintOpen: true,
        mintFeeRecipient: zeroAddress,
        contractURI: '',
    });

    spgNftContract = newCollection.spgNftContract;
    console.log(`✅ Collection created: ${spgNftContract}`);
    console.log(`   Transaction: ${newCollection.txHash}`);
    
    return spgNftContract;
}

// Register IP Asset endpoint
app.post('/register-ip', async (req, res) => {
    try {
        const { 
            imageCid,           // IPFS CID of the original image (from IPFS service)
            metadataCid,        // IPFS CID of the metadata JSON (from IPFS service) - OPTIONAL
            depthMetadata,      // Depth information metadata (if not using metadataCid)
            deviceAddress,      // Device wallet address (for attribution)
            mintingFee,         // Minting fee in IP tokens (e.g., "0.1") - SET BY USER
            commercialRevShare  // Revenue share percentage (e.g., 10) - SET BY USER
        } = req.body;

        // Validation - need either imageCid or both
        if (!imageCid || !deviceAddress) {
            return res.status(400).json({
                error: 'Missing required fields',
                required: ['imageCid', 'deviceAddress']
            });
        }

        // If metadataCid provided, fetch it from IPFS
        let finalDepthMetadata = depthMetadata;
        if (metadataCid && !depthMetadata) {
            console.log(`   Fetching metadata from IPFS: ${metadataCid}`);
            try {
                const fullMetadata = await fetchFromIPFS(metadataCid);
                // Extract depth data from the full metadata
                if (fullMetadata.data && fullMetadata.data.depthData) {
                    finalDepthMetadata = fullMetadata.data.depthData;
                } else {
                    finalDepthMetadata = fullMetadata;
                }
            } catch (error) {
                console.warn(`   Warning: Could not fetch metadata CID, will use basic info`);
                finalDepthMetadata = { metadataCid };
            }
        }

        if (!finalDepthMetadata) {
            finalDepthMetadata = { note: 'No depth metadata provided' };
        }

        // Use provided values or defaults
        const finalMintingFee = mintingFee ? parseEther(mintingFee.toString()) : parseEther(DEFAULT_MINTING_FEE);
        const finalRevShare = commercialRevShare !== undefined ? parseInt(commercialRevShare) : DEFAULT_COMMERCIAL_REV_SHARE;

        // Validate ranges
        if (finalRevShare < 0 || finalRevShare > 100) {
            return res.status(400).json({
                error: 'Commercial revenue share must be between 0 and 100',
                provided: finalRevShare
            });
        }

        console.log(`\n📝 Registering IP for image: ${imageCid}`);
        console.log(`   Device: ${deviceAddress}`);
        console.log(`   Minting Fee: ${Number(finalMintingFee) / 1e18} IP tokens`);
        console.log(`   Revenue Share: ${finalRevShare}%`);

        // Get or create collection
        const nftContract = await getOrCreateCollection();

        // Prepare IPFS URLs - use HTTP gateway for browser compatibility
        const imageHttpUrl = `https://gateway.pinata.cloud/ipfs/${imageCid}`;
        const metadataHttpUrl = metadataCid ? `https://gateway.pinata.cloud/ipfs/${metadataCid}` : imageHttpUrl;

        console.log(`   Image URL: ${imageHttpUrl}`);
        console.log(`   Metadata URL: ${metadataHttpUrl}`);

        // Create IP Metadata - Story Protocol format
        // CRITICAL: Use ipfs:// protocol in the metadata JSON itself (not HTTP!)
        // But we'll upload this JSON and use HTTP gateway for the URI
        const ipMetadata = storyClient.ipAsset.generateIpMetadata({
            title: `DeepShare Evidence - ${Date.now()}`,
            description: metadataCid 
                ? `Evidence capture with depth mapping. Full depth data stored at: ${metadataHttpUrl}`
                : `Evidence capture. Device: ${deviceAddress}`,
            createdAt: Math.floor(Date.now() / 1000).toString(),
            creators: [{
                name: 'DeepShare Device',
                address: deviceAddress,
                contributionPercent: 100,
            }],
            image: `ipfs://${imageCid}`,  // Use ipfs:// in the metadata JSON
            imageHash: `0x${createHash('sha256').update(imageCid).digest('hex')}`,
            mediaUrl: metadataCid ? `ipfs://${metadataCid}` : `ipfs://${imageCid}`,  // Link to full depth data
            mediaHash: metadataCid ? `0x${createHash('sha256').update(metadataCid).digest('hex')}` : `0x${createHash('sha256').update(imageCid).digest('hex')}`,
            mediaType: metadataCid ? 'application/json' : 'image/jpeg',
            attributes: [
                { key: 'Platform', value: 'DeepShare' },
                { key: 'Type', value: 'Evidence with Depth Mapping' },
                { key: 'Device', value: deviceAddress },
                { key: 'ImageCID', value: imageCid },
                { key: 'MetadataCID', value: metadataCid || 'N/A' },
                { key: 'DepthDataURL', value: metadataCid ? metadataHttpUrl : 'N/A' },
            ],
        });

        // Upload IP metadata JSON to IPFS
        const ipIpfsHash = await uploadJSONToIPFS(ipMetadata);
        const ipHash = createHash('sha256').update(JSON.stringify(ipMetadata)).digest('hex');

        // Create NFT Metadata - OpenSea compatible
        const nftMetadata = {
            name: `DeepShare Evidence ${Date.now()}`,
            description: metadataCid 
                ? `Evidence captured with depth mapping technology. Full depth data available in metadata.`
                : 'Evidence captured with depth mapping technology',
            image: `ipfs://${imageCid}`,  // Use ipfs:// in the metadata JSON
            animation_url: metadataCid ? `ipfs://${metadataCid}` : undefined,
            external_url: metadataCid ? metadataHttpUrl : imageHttpUrl,
            attributes: [
                { trait_type: 'Platform', value: 'DeepShare' },
                { trait_type: 'Device', value: deviceAddress },
                { trait_type: 'Timestamp', value: new Date().toISOString() },
                { trait_type: 'Has Depth Data', value: metadataCid ? 'Yes' : 'No' },
                { trait_type: 'Image CID', value: imageCid },
                { trait_type: 'Metadata CID', value: metadataCid || 'N/A' },
            ],
        };

        // Upload NFT metadata JSON to IPFS
        const nftIpfsHash = await uploadJSONToIPFS(nftMetadata);
        const nftHash = createHash('sha256').update(JSON.stringify(nftMetadata)).digest('hex');
        
        console.log(`   IP metadata uploaded: ${ipIpfsHash}`);
        console.log(`   NFT metadata uploaded: ${nftIpfsHash}`);

        console.log('   Registering IP Asset on Story Protocol...');

        // Register IP Asset with Commercial License
        const response = await storyClient.ipAsset.registerIpAsset({
            nft: {
                type: 'mint',
                spgNftContract: nftContract,
            },
            licenseTermsData: [{
                terms: PILFlavor.commercialRemix({
                    commercialRevShare: finalRevShare,
                    defaultMintingFee: finalMintingFee,
                    currency: WIP_TOKEN_ADDRESS,
                }),
            }],
            ipMetadata: {
                ipMetadataURI: `https://ipfs.io/ipfs/${ipIpfsHash}`,  // Points to uploaded Story Protocol metadata
                ipMetadataHash: `0x${ipHash}`,
                nftMetadataURI: `https://ipfs.io/ipfs/${nftIpfsHash}`,  // Points to uploaded NFT metadata
                nftMetadataHash: `0x${nftHash}`,
            },
        });

        console.log(`✅ IP Asset registered: ${response.ipId}`);
        console.log(`   Transaction: ${response.txHash}`);

        // Construct IP explorer URL
        const ipExplorerUrl = `https://aeneid.explorer.story.foundation/ipa/${response.ipId}`;
        
        // Update Supabase with IP URL and transaction hash
        await updateSupabaseWithIPData(imageCid, ipExplorerUrl, response.txHash);

        // Return success response
        res.json({
            success: true,
            data: {
                ipId: response.ipId,
                tokenId: response.tokenId?.toString(),
                licenseTermsIds: response.licenseTermsIds?.map(id => id.toString()),
                txHash: response.txHash,
                nftContract,
                imageUrl: imageHttpUrl,
                imageCid,
                metadataUrl: metadataHttpUrl,
                metadataCid: metadataCid || null,
                depthMetadata: finalDepthMetadata,
                mintingFee: Number(finalMintingFee) / 1e18,
                commercialRevShare: finalRevShare,
                explorerUrl: ipExplorerUrl,
                transactionUrl: `https://aeneid.storyscan.io/tx/${response.txHash}`,
            },
            timestamp: new Date().toISOString(),
        });

    } catch (error) {
        console.error('❌ Error registering IP:', error.message);
        res.status(500).json({
            success: false,
            error: error.message,
            timestamp: new Date().toISOString(),
        });
    }
});

// Check wallet balance on startup
storyClient.getWalletBalance().then(balance => {
    const balanceInIP = Number(balance) / 1e18;
    console.log(`   Balance: ${balanceInIP.toFixed(4)} IP tokens`);
    
    if (balanceInIP < 0.1) {
        console.warn(`\n⚠️  WARNING: Low balance! You need IP tokens for gas fees.`);
        console.warn(`   Get testnet tokens: https://faucet.story.foundation/`);
        console.warn(`   Your address: ${serverWalletAddress}\n`);
    }
}).catch(err => {
    console.error('   Could not check balance:', err.message);
});

// Start server
app.listen(PORT, () => {
    console.log(`\n🚀 DeepShare IP Registration Server`);
    console.log(`   Port: ${PORT}`);
    console.log(`   Network: ${CHAIN_ID}`);
    console.log(`   RPC: ${RPC_URL}`);
    console.log(`   Default License Fee: ${DEFAULT_MINTING_FEE} IP tokens`);
    console.log(`   Default Revenue Share: ${DEFAULT_COMMERCIAL_REV_SHARE}%`);
    console.log(`   Note: Users can override these per capture`);
    console.log(`\n✅ Server ready to register IP assets\n`);
});

module.exports = app;

