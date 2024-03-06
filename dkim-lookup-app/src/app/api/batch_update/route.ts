import { createDkimRecord, dspToString, prisma, recordToString, updateDspTimestamp } from '@/lib/db';
import { fetchDkimDnsRecord } from '@/lib/fetchDkimDnsRecord';
import { generateWitness } from '@/lib/generateWitness';
import { DomainSelectorPair } from '@prisma/client';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

function getNumRecords() {
	let takeParam = process.env.BATCH_UPDATE_NUM_RECORDS;
	if (takeParam) {
		console.log(`using process.env.BATCH_UPDATE_NUM_RECORDS: ${takeParam}`);
		let take = Number(takeParam);
		if (isNaN(take)) {
			console.log(`invalid process.env.BATCH_UPDATE_NUM_RECORDS: ${takeParam}, using 0`);
			return 0;
		}
		return take;
	} else {
		console.log('process.env.BATCH_UPDATE_NUM_RECORDS not set, using 0');
		return 0;
	}
}

/**
 * @returns true iff a record was added
 */
async function fetchAndStoreDkimDnsRecord(dsp: DomainSelectorPair) {
	console.log(`fetching ${dsp.selector}._domainkey.${dsp.domain} from dns`);
	let dkimDnsRecord = await fetchDkimDnsRecord(dsp.domain, dsp.selector);
	if (!dkimDnsRecord) {
		console.log(`no record found for ${dsp.selector}, ${dsp.domain}`);
		return;
	}
	let dkimRecord = await prisma.dkimRecord.findFirst({
		where: {
			domainSelectorPair: dsp,
			value: dkimDnsRecord.value
		},
	});

	if (dkimRecord) {
		console.log(`record already exists: ${recordToString(dkimRecord)} for domain/selector pair ${dspToString(dsp)}, updating lastSeenAt to ${dkimDnsRecord.timestamp}`);
		await prisma.dkimRecord.update({
			where: { id: dkimRecord.id },
			data: { lastSeenAt: dkimDnsRecord.timestamp }
		});
	}
	else {
		dkimRecord = await createDkimRecord(dsp, dkimDnsRecord);
	}

	if (!dkimRecord.provenanceVerified) {
		generateWitness(dsp, dkimRecord);
	}
}

export async function GET(request: NextRequest) {
	const authHeader = request.headers.get('authorization');
	if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
		return new Response('Unauthorized', { status: 401 });
	}

	let numRecords = getNumRecords();
	try {
		const oneDayAgo = new Date(Date.now() - 1000 * 60 * 60 * 24);
		const dsps = await prisma.domainSelectorPair.findMany(
			{
				where: { lastRecordUpdate: { lte: oneDayAgo } },
				orderBy: { lastRecordUpdate: 'asc' },
				take: numRecords,
			}
		);
		console.log(`found ${dsps.length} records to update, max limit: ${numRecords}`);
		for (const dsp of dsps) {
			try {
				await fetchAndStoreDkimDnsRecord(dsp);
				updateDspTimestamp(dsp, new Date());
			}
			catch (error) {
				console.log(`error updating ${dsp.domain}, ${dsp.selector}: ${error}`);
				throw error;
			}
		}
		return NextResponse.json({ updatedRecords: dsps }, { status: 200 });
	}
	catch (error: any) {
		return NextResponse.json(error.toString(), { status: 500 });
	}
}