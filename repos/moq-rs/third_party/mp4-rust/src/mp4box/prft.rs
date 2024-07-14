use byteorder::{BigEndian, ReadBytesExt, WriteBytesExt};
use serde::Serialize;
use std::io::{Read, Seek, Write};

use crate::mp4box::*;

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize)]
pub struct PrftBox {
    pub version: u8,
    pub flags: u32,
    pub reference_track_id: u32,
    pub ntp_timestamp: u64,
    pub media_time: u64,
}

impl PrftBox {
    pub fn get_type(&self) -> BoxType {
        BoxType::PrftBox
    }

    pub fn get_size(&self) -> u64 {
        let mut size = HEADER_SIZE + HEADER_EXT_SIZE;

        // Add 4 bytes for reference_track_id
        size += 4;

        // Add 8 bytes for ntp_timestamp
        size += 8;

        // Decide the size of media_time
        if self.version == 1 {
            size += 8;
        } else if self.version == 0 {
            size += 4;
        }
        size
    }
}

impl Mp4Box for PrftBox {
    fn box_type(&self) -> BoxType {
        self.get_type()
    }

    fn box_size(&self) -> u64 {
        self.get_size()
    }

    fn to_json(&self) -> Result<String> {
        Ok(serde_json::to_string(&self).unwrap())
    }

    fn summary(&self) -> Result<String> {
        let s = format!(
            "reference_track_id={} ntp_timestamp={} media_time={}",
            self.reference_track_id, self.ntp_timestamp, self.media_time
        );
        Ok(s)
    }
}

impl<R: Read + Seek> ReadBox<&mut R> for PrftBox {
    fn read_box(reader: &mut R, size: u64) -> Result<Self> {
        let start = box_start(reader)?;

        let (version, flags) = read_box_header_ext(reader)?;

        let reference_track_id = reader.read_u32::<BigEndian>()?;
        let ntp_timestamp = reader.read_u64::<BigEndian>()?;

        let media_time = if version == 1 {
            reader.read_u64::<BigEndian>()?
        } else if version == 0 {
            reader.read_u32::<BigEndian>()? as u64
        } else {
            return Err(Error::InvalidData("version must be 0 or 1"));
        };

        skip_bytes_to(reader, start + size)?;

        Ok(PrftBox {
            version,
            flags,
            reference_track_id,
            ntp_timestamp,
            media_time,
        })
    }
}

impl<W: Write> WriteBox<&mut W> for PrftBox {
    fn write_box(&self, writer: &mut W) -> Result<u64> {
        let size = self.box_size();
        BoxHeader::new(self.box_type(), size).write(writer)?;

        write_box_header_ext(writer, self.version, self.flags)?;

        writer.write_u32::<BigEndian>(self.reference_track_id)?;
        writer.write_u64::<BigEndian>(self.ntp_timestamp)?;

        if self.version == 1 {
            writer.write_u64::<BigEndian>(self.media_time)?;
        } else if self.version == 0 {
            writer.write_u32::<BigEndian>(self.media_time as u32)?;
        } else {
            return Err(Error::InvalidData("version must be 0 or 1"));
        }

        Ok(size)
    }
}
