import importlib.util
import sys
import types
import unittest
from pathlib import Path
from unittest import mock

from specklepy.objects.data_objects import DataObject
from specklepy.objects.models.collections.collection import Collection


MODULE_PATH = Path(__file__).resolve().with_name('import_file.py')
spec = importlib.util.spec_from_file_location('rvt_import_file', MODULE_PATH)
module = importlib.util.module_from_spec(spec)
assert spec and spec.loader
spec.loader.exec_module(module)


class DummyRevitFile:
    def read_adocument(self):
        return {
            'entry_offset': 42,
            'version': 2024,
            'fields': [
                {'name': 'Category', 'kind': 'string', 'value': 'Walls'},
                {'name': 'Level', 'kind': 'int', 'value': 2},
            ],
        }


class DummySchemaRevitFile:
    def schema_json(self):
        return '{"classes":[{"name":"Wall","fields":[{"name":"Id","cpp_type":"int"},{"name":"Level","cpp_type":"int"}],"tag":1,"offset":10},{"name":"Column","fields":[{"name":"TopLevel","cpp_type":"int"}],"tag":2,"offset":20}],"cpp_types":["int"],"skipped_records":0}'


class DummyIfcRevitFile:
    def write_ifc(self):
        return 'ISO-10303-21;HEADER;ENDSEC;DATA;#1=IFCWALL();ENDSEC;END-ISO-10303-21;'


class DummySummaryRevitFile:
    def schema_summary(self):
        return '{"classCount": 2, "classes": ["Wall", "Column"]}'


class DummyBasicInfoRevitFile:
    def basic_file_info_json(self):
        return '{"title":"SampleProject","units":"m"}'

    def part_atom_json(self):
        return '{"partAtomTitle":"SamplePart"}'


class DummyRawMetadataRevitFile:
    def basic_file_info_json(self):
        return 'not-json-data'

    def part_atom_json(self):
        return 'not-json-part-atom'


class DummyStreamRevitFile:
    def stream_names(self):
        return ['Formats/Latest', 'ProjectInfo']

    def missing_required_streams(self):
        return ['Global/Latest']


class DummyStreamContentRevitFile(DummyStreamRevitFile):
    def read_stream(self, name):
        return '{"stream": "' + name + '", "status": "ok", "payload": {"version": 2024, "bytes": "hello"}}'


class ImportFileDocumentCollectionTests(unittest.TestCase):
    def test_document_collections_uses_supported_read_document_api(self):
        result = module._document_collections(DummyRevitFile())

        self.assertEqual(result.name, 'Document')
        self.assertGreater(len(result.elements), 0)
        self.assertEqual(result.elements[0].name, 'ADocument')

    def test_schema_collections_uses_supported_schema_json_api(self):
        result = module._schema_collections(DummySchemaRevitFile())

        self.assertEqual(result.name, 'Schema')
        self.assertGreater(len(result.elements), 0)
        self.assertEqual(result.elements[0].name, 'Wall')
        self.assertEqual(result.elements[0].properties['fieldCount'], 2)

    def test_ifc_export_uses_supported_write_ifc_api(self):
        result = module._ifc_export(DummyIfcRevitFile())

        self.assertEqual(result.name, 'IFC Export')
        self.assertIn('IFCWALL', result.properties['ifcStep'])
        self.assertEqual(result.properties['truncated'], False)

    def test_stream_collections_use_supported_stream_api(self):
        result = module._stream_collections(DummyStreamRevitFile())

        self.assertEqual(result.name, 'Streams')
        self.assertEqual(result.elements[0].name, 'Stream Summary')
        self.assertEqual(result.elements[0].properties['missingRequiredStreamCount'], 1)
        self.assertEqual(result.elements[1].name, 'Formats/Latest')
        self.assertEqual(result.elements[1].properties['missingRequired'], False)

    def test_stream_content_collections_use_supported_read_stream_api(self):
        result = module._stream_content_collections(DummyStreamContentRevitFile())

        self.assertEqual(result.name, 'Stream Content')
        self.assertGreater(len(result.elements), 0)
        self.assertEqual(result.elements[0].name, 'Formats/Latest')
        self.assertEqual(result.elements[0].properties['streamName'], 'Formats/Latest')
        self.assertEqual(result.elements[0].properties['contentType'], 'structured')
        self.assertEqual(result.elements[0].properties['content']['payload']['bytes'], 'hello')

    def test_schema_summary_collections_use_supported_schema_summary_api(self):
        result = module._schema_summary_collections(DummySummaryRevitFile())

        self.assertEqual(result.name, 'Schema Summary')
        self.assertGreater(len(result.elements), 0)
        self.assertEqual(result.elements[0].name, 'SchemaSummary')
        self.assertEqual(result.elements[0].properties['classCount'], 2)

    def test_basic_file_and_part_atom_collections_are_structured(self):
        basic_info = module._basic_file_info_collection(DummyBasicInfoRevitFile())
        part_atom = module._part_atom_collection(DummyBasicInfoRevitFile())

        self.assertEqual(basic_info.name, 'Basic File Info')
        self.assertEqual(part_atom.name, 'Part Atom')
        self.assertEqual(basic_info.elements[0].properties['title'], 'SampleProject')
        self.assertEqual(part_atom.elements[0].properties['partAtomTitle'], 'SamplePart')

    def test_non_json_metadata_is_preserved_without_crashing(self):
        basic_info = module._basic_file_info_collection(DummyRawMetadataRevitFile())
        part_atom = module._part_atom_collection(DummyRawMetadataRevitFile())

        self.assertEqual(basic_info.name, 'Basic File Info')
        self.assertEqual(part_atom.name, 'Part Atom')
        self.assertEqual(basic_info.elements[0].properties['value'], 'not-json-data')
        self.assertEqual(part_atom.elements[0].properties['value'], 'not-json-part-atom')


class DummyGeometryRevitFile:
    version = 2025
    build = '20240119_1515(x64)'
    guid = 'abc'
    original_path = 'E:\\Projects\\Tower.rvt'

    def __init__(self, total):
        self.total = total
        self.ifc_written = False

    def element_counts(self):
        return {'total': self.total, 'by_class': {'Wall': self.total}}

    def basic_file_info_json(self):
        return '{"title":"Tower"}'

    def write_ifc(self):
        self.ifc_written = True
        return 'ISO-10303-21;HEADER;ENDSEC;DATA;#1=IFCWALL();ENDSEC;END-ISO-10303-21;'


def fake_speckleifc(converted_root, seen_ifc):
    """Stand-in speckleifc modules: records the IFC text it was handed."""
    processing = types.ModuleType('speckleifc.ifc_geometry_processing')
    importer = types.ModuleType('speckleifc.importer')

    def open_ifc(path):
        seen_ifc.append(Path(path).read_text(encoding='utf-8'))
        return 'ifc-file'

    class ImportJob:
        def __init__(self, ifc_file, progress):
            assert ifc_file == 'ifc-file'
            assert not progress.should_report_progress()

        def convert(self):
            return converted_root

    processing.open_ifc = open_ifc
    importer.ImportJob = ImportJob
    return {
        'speckleifc': types.ModuleType('speckleifc'),
        'speckleifc.ifc_geometry_processing': processing,
        'speckleifc.importer': importer,
    }


class ImportFileGeometryTests(unittest.TestCase):
    def test_no_decoded_elements_falls_back_to_metadata(self):
        revit_file = DummyGeometryRevitFile(total=0)

        self.assertIsNone(module.convert_rvt_geometry('Tower.rvt', revit_file))
        self.assertFalse(revit_file.ifc_written)

    def test_missing_speckleifc_falls_back_to_metadata(self):
        with mock.patch.dict(sys.modules, {'speckleifc': None}):
            result = module.convert_rvt_geometry('Tower.rvt', DummyGeometryRevitFile(3))

        self.assertIsNone(result)

    def test_decoded_elements_are_converted_through_speckleifc(self):
        root = Collection(name='E:\\Projects\\Tower.rvt', elements=[])
        seen_ifc = []
        with mock.patch.dict(sys.modules, fake_speckleifc(root, seen_ifc)):
            result = module.convert_rvt_geometry('Tower.rvt', DummyGeometryRevitFile(3))

        self.assertIs(result, root)
        self.assertEqual(len(seen_ifc), 1)
        self.assertIn('IFCWALL', seen_ifc[0])
        # Original author-machine path trimmed to the file name
        self.assertEqual(result.name, 'Tower.rvt')
        file_info = result.elements[-1]
        self.assertEqual(file_info.speckle_type.split(':')[-1], 'Objects.Data.RevitFile')
        self.assertEqual(file_info.properties['decodedElementCount'], 3)
        self.assertEqual(file_info.properties['basicFileInfo'], {'title': 'Tower'})


class NulStrippingTests(unittest.TestCase):
    # Postgres jsonb rejects U+0000, which fails the whole upload
    def test_json_safe_value_drops_nul(self):
        self.assertEqual(
            module._json_safe_value({'a\x00b': ['x\x00y', b'p\x00q']}),
            {'ab': ['xy', 'pq']},
        )

    def test_strip_nul_in_tree_cleans_nested_objects(self):
        child = DataObject(
            name='wall\x00', properties={'k\x00': 'v\x00', 'n': [1, 'a\x00']}, displayValue=[]
        )
        root = Collection(name='root\x00', elements=[child])

        module._strip_nul_in_tree(root)

        self.assertEqual(root.name, 'root')
        self.assertEqual(child.name, 'wall')
        self.assertEqual(child.properties, {'k': 'v', 'n': [1, 'a']})


if __name__ == '__main__':
    unittest.main()
