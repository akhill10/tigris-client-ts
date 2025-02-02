import { DecoratorMetaStorage } from "../decorators/metadata/decorator-meta-storage";
import { getDecoratorMetaStorage } from "../globals";
import {
	CollectionFieldOptions,
	TigrisCollectionType,
	TigrisDataTypes,
	TigrisSchema,
} from "../types";
import { SearchFieldOptions, TigrisIndexSchema, TigrisIndexType } from "../search";
import { SearchFieldMetadata } from "../decorators/metadata/search-field-metadata";
import { FieldMetadata } from "../decorators/metadata/field-metadata";
import { PrimaryKeyMetadata } from "../decorators/metadata/primary-key-metadata";
import { IncompletePrimaryKeyOrderError } from "../error";

export type CollectionSchema<T extends TigrisCollectionType> = {
	name: string;
	schema: TigrisSchema<T>;
};

export type IndexSchema<T extends TigrisIndexType> = {
	name: string;
	schema: TigrisIndexSchema<T>;
};

/** @internal */
export class DecoratedSchemaProcessor {
	private static _instance: DecoratedSchemaProcessor;
	private readonly storage: DecoratorMetaStorage;

	private constructor() {
		this.storage = getDecoratorMetaStorage();
	}

	static get Instance(): DecoratedSchemaProcessor {
		if (!DecoratedSchemaProcessor._instance) {
			DecoratedSchemaProcessor._instance = new DecoratedSchemaProcessor();
		}
		return DecoratedSchemaProcessor._instance;
	}

	processIndex(cls: new () => TigrisIndexType): IndexSchema<typeof cls> {
		const index = this.storage.getIndexByTarget(cls);
		const schema = this.buildTigrisSchema(index.target, false);
		return {
			name: index.indexName,
			schema: schema as TigrisIndexSchema<typeof cls>,
		};
	}

	processCollection(cls: new () => TigrisCollectionType): CollectionSchema<typeof cls> {
		const collection = this.storage.getCollectionByTarget(cls);
		const schema = this.buildTigrisSchema(collection.target, true);
		this.addPrimaryKeys(schema, collection.target);
		return {
			name: collection.collectionName,
			schema: schema as TigrisSchema<typeof cls>,
		};
	}

	private buildTigrisSchema(
		from: Function,
		forCollection: boolean,
		parentFieldType?: TigrisDataTypes
	): TigrisSchema<unknown> | TigrisIndexSchema<unknown> {
		const schema = {};
		// get all top level fields matching this target
		const fields = this.getSchemaFields(from, forCollection);

		// process each field
		for (const field of fields) {
			const key = field.name;
			if (!(key in schema)) {
				schema[key] = { type: field.type };
			}

			let arrayItems: Object, arrayDepth: number;

			switch (field.type) {
				case TigrisDataTypes.ARRAY:
					arrayItems =
						typeof field.embedType === "function"
							? {
									type: this.buildTigrisSchema(
										field.embedType as Function,
										forCollection,
										parentFieldType ?? field.type
									),
							  }
							: { type: field.embedType as TigrisDataTypes };
					arrayDepth = field.arrayDepth && field.arrayDepth > 1 ? field.arrayDepth : 1;
					schema[key] = this.buildNestedArray(arrayItems, arrayDepth);
					break;
				case TigrisDataTypes.OBJECT:
					if (typeof field.embedType === "function") {
						const embedSchema = this.buildTigrisSchema(
							field.embedType as Function,
							forCollection,
							parentFieldType ?? field.type
						);
						// generate embedded schema as its a class
						if (Object.keys(embedSchema).length > 0) {
							schema[key] = {
								type: this.buildTigrisSchema(
									field.embedType as Function,
									forCollection,
									parentFieldType ?? field.type
								),
							};
						}
					}
					break;
				case TigrisDataTypes.STRING:
					if (field.schemaFieldOptions && "maxLength" in field.schemaFieldOptions) {
						schema[key].maxLength = field.schemaFieldOptions.maxLength;
					}
					break;
			}

			// process any field optionals
			if (field.schemaFieldOptions) {
				// set value for field,  if any
				for (const opKey of schemaOptions) {
					if (schemaOptionSupported(field.schemaFieldOptions, field.type, parentFieldType, opKey)) {
						schema[key][opKey.attrName] = field.schemaFieldOptions[opKey.attrName];
					}
				}
			}
		}
		return forCollection
			? (schema as TigrisSchema<unknown>)
			: (schema as TigrisIndexSchema<unknown>);
	}

	private buildNestedArray(items, depth: number) {
		let head: Object, prev: Object, next: Object;
		while (depth > 0) {
			if (!head) {
				next = {};
				head = next;
			}
			next["type"] = TigrisDataTypes.ARRAY;
			next["items"] = {};
			prev = next;
			next = next["items"];
			depth -= 1;
		}
		prev["items"] = items;
		return head;
	}

	private addPrimaryKeys<T extends TigrisCollectionType>(
		targetSchema: TigrisSchema<T>,
		collectionClass: Function
	) {
		const primaryKeysMetadata: PrimaryKeyMetadata[] = this.storage.getPKsByTarget(collectionClass);
		this.validatePrimaryKeysOrder(primaryKeysMetadata, collectionClass);
		for (const pk of primaryKeysMetadata) {
			if (!(pk.name in targetSchema)) {
				targetSchema[pk.name] = {
					type: pk.type,
				};
			}
			targetSchema[pk.name]["primary_key"] = {
				order: pk.options?.order ?? 1,
				autoGenerate: pk.options?.autoGenerate === true,
			};
		}
	}

	private validatePrimaryKeysOrder(primaryKeys: PrimaryKeyMetadata[], collectionClass: Function) {
		if (primaryKeys.length > 1) {
			for (const pk of primaryKeys) {
				if (!pk?.options?.order) {
					throw new IncompletePrimaryKeyOrderError(pk.name, collectionClass.name);
				}
			}
		}
	}

	private getSchemaFields(
		from: Function,
		forCollection: boolean
	): (SearchFieldMetadata | FieldMetadata)[] {
		const searchFields: (SearchFieldMetadata | FieldMetadata)[] =
			this.storage.getSearchFieldsByTarget(from);

		if (!forCollection) {
			return searchFields;
		}

		const fields = [];

		// create a lookup for search fields
		const searchFieldsLookup = [];
		for (const field of searchFields) {
			searchFieldsLookup[field.name] = field;
		}

		// process the collection fields
		const visitedFields = new Set();
		const collectionFields = this.storage.getCollectionFieldsByTarget(from);
		for (const cf of collectionFields) {
			let fieldOption = cf.schemaFieldOptions;

			// if a search field is defined for this field, merge its options
			const searchField = searchFieldsLookup[cf.name];
			if (searchField) {
				fieldOption = { ...cf.schemaFieldOptions, ...searchField.schemaFieldOptions };
			}

			fields.push({
				...cf,
				schemaFieldOptions: fieldOption,
			});

			visitedFields.add(cf.name);
		}

		// process the additional fields that are tagged as search fields
		for (const sf of searchFields) {
			if (!visitedFields.has(sf.name)) {
				fields.push(sf);
			}
		}

		return fields;
	}
}

interface SchemaFieldOptions {
	attrName: string;
	doesNotApplyTo: Set<TigrisDataTypes>;
	doesNotApplyToParent: Set<TigrisDataTypes>;
}

const schemaOptions: SchemaFieldOptions[] = [
	{
		attrName: "default",
		doesNotApplyTo: new Set(),
		doesNotApplyToParent: new Set(),
	},
	{
		attrName: "timestamp",
		doesNotApplyTo: new Set([TigrisDataTypes.OBJECT]),
		doesNotApplyToParent: new Set(),
	},
	{
		attrName: "searchIndex",
		doesNotApplyTo: new Set([TigrisDataTypes.OBJECT]),
		doesNotApplyToParent: new Set([TigrisDataTypes.ARRAY]),
	},
	{
		attrName: "sort",
		doesNotApplyTo: new Set([TigrisDataTypes.OBJECT]),
		doesNotApplyToParent: new Set([TigrisDataTypes.ARRAY]),
	},
	{
		attrName: "facet",
		doesNotApplyTo: new Set([TigrisDataTypes.OBJECT]),
		doesNotApplyToParent: new Set([TigrisDataTypes.ARRAY]),
	},
	{
		attrName: "dimensions",
		doesNotApplyTo: new Set([TigrisDataTypes.OBJECT, TigrisDataTypes.NUMBER]),
		doesNotApplyToParent: new Set([TigrisDataTypes.ARRAY]),
	},
	{
		attrName: "id",
		doesNotApplyTo: new Set([
			TigrisDataTypes.OBJECT,
			TigrisDataTypes.ARRAY,
			TigrisDataTypes.NUMBER,
			TigrisDataTypes.BOOLEAN,
			TigrisDataTypes.NUMBER_BIGINT,
			TigrisDataTypes.INT64,
			TigrisDataTypes.INT32,
			TigrisDataTypes.DATE_TIME,
		]),
		doesNotApplyToParent: new Set([TigrisDataTypes.ARRAY]),
	},
	{
		attrName: "index",
		doesNotApplyTo: new Set([TigrisDataTypes.OBJECT, TigrisDataTypes.ARRAY]),
		doesNotApplyToParent: new Set([TigrisDataTypes.ARRAY, TigrisDataTypes.OBJECT]),
	},
];

// searchIndex, sort and facet tags cannot be defined on top level object
// and can only be defined on the fields of the object
// { "field1": { "type": "object", "properties": { "name": { "type": "string" } }, "searchIndex": true } - not supported
// { "field1": { "type": "object", "properties": { "name": { "type": "string", "searchIndex": true } } } - supported
// searchIndex, sort and facet tags cannot be defined within a nested array
// { "field1": { "type": "array", "items": { "type": "object", "properties": { "name": { "type": "string", "searchIndex": true } } } } - not supported
// { "field1": { "type": "array", "items": { "type": "object", "properties": { "name": { "type": "string" } } }, "searchIndex": true } - supported
function schemaOptionSupported(
	fieldOptions: SearchFieldOptions | CollectionFieldOptions,
	fieldType: TigrisDataTypes,
	fieldParentType: TigrisDataTypes,
	attr: SchemaFieldOptions
): boolean {
	if (
		attr.attrName in fieldOptions &&
		!attr.doesNotApplyTo.has(fieldType) &&
		(!fieldParentType || !attr.doesNotApplyToParent.has(fieldParentType))
	) {
		return true;
	}

	return false;
}
