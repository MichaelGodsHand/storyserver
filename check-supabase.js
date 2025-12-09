/**
 * Quick script to verify Supabase connection and table structure
 * Run: node check-supabase.js
 */

require('dotenv').config();
const axios = require('axios');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

async function checkSupabase() {
    console.log('\n🔍 Supabase Connection Check\n');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    
    // Check credentials
    if (!SUPABASE_URL) {
        console.log('❌ SUPABASE_URL not found in .env');
        console.log('   Add: SUPABASE_URL=https://your-project.supabase.co\n');
        return;
    }
    
    if (!SUPABASE_KEY) {
        console.log('❌ SUPABASE_SERVICE_ROLE_KEY not found in .env');
        console.log('   Add: SUPABASE_SERVICE_ROLE_KEY=your_key_here\n');
        return;
    }
    
    console.log('✅ Credentials found:');
    console.log(`   URL: ${SUPABASE_URL}`);
    console.log(`   Key: ${SUPABASE_KEY.substring(0, 30)}...\n`);
    
    // Test connection
    try {
        const url = `${SUPABASE_URL}/rest/v1/images?select=wallet_address,image_cid,metadata_cid,ip,tx_hash&limit=1`;
        const headers = {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'application/json',
        };
        
        console.log('🔌 Testing connection to images table...');
        const response = await axios.get(url, { headers, timeout: 10000 });
        
        console.log('✅ Connection successful!\n');
        
        if (response.data && response.data.length > 0) {
            console.log('📊 Sample row from images table:');
            console.log(JSON.stringify(response.data[0], null, 2));
            console.log('');
            
            // Check if columns exist
            const row = response.data[0];
            const hasIpColumn = 'ip' in row;
            const hasTxHashColumn = 'tx_hash' in row;
            
            if (hasIpColumn && hasTxHashColumn) {
                console.log('✅ Both columns exist: ip, tx_hash');
            } else {
                if (!hasIpColumn) {
                    console.log('❌ Column "ip" not found in table');
                    console.log('   Run this SQL in Supabase:');
                    console.log('   ALTER TABLE images ADD COLUMN ip TEXT;\n');
                }
                if (!hasTxHashColumn) {
                    console.log('❌ Column "tx_hash" not found in table');
                    console.log('   Run this SQL in Supabase:');
                    console.log('   ALTER TABLE images ADD COLUMN tx_hash TEXT;\n');
                }
            }
        } else {
            console.log('⚠️  Table is empty. Columns to verify:');
            console.log('   - wallet_address');
            console.log('   - image_cid');
            console.log('   - metadata_cid');
            console.log('   - ip (should be TEXT)');
            console.log('   - tx_hash (should be TEXT)\n');
        }
        
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('✅ Setup looks good! Ready to update database.\n');
        
    } catch (error) {
        console.log('❌ Connection failed!\n');
        console.log(`Error: ${error.message}`);
        if (error.response) {
            console.log(`Status: ${error.response.status}`);
            console.log(`Response:`, error.response.data);
        }
        console.log('\nPossible issues:');
        console.log('1. Wrong Supabase URL or API key');
        console.log('2. Table "images" doesn\'t exist');
        console.log('3. RLS policies blocking access (use SERVICE_ROLE_KEY)\n');
    }
}

checkSupabase();

