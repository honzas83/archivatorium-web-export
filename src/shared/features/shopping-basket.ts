import { FeatureOptions, FeatureSettingInfo } from "./feature-options-base";

export class ShoppingBasketOptions extends FeatureOptions {
	checkoutEndpoint: string = "/api/checkout";
	info_checkoutEndpoint = new FeatureSettingInfo({
		description: "The server endpoint that creates Markdown subset zip downloads.",
	});

	constructor() {
		super();
		this.featureId = "shopping-basket";
	}
}
